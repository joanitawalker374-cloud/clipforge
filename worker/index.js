// index.js — worker HTTP. Reçoit un jobId, traite la vidéo, dépose le résultat,
// met à jour la ligne `jobs` en base. Sécurisé par un secret partagé (WORKER_SECRET).
// Traitement séquentiel (1 job à la fois) + libération des jobs bloqués : conçu pour
// tenir sur une petite instance (512 Mo) sans dépasser la limite mémoire.
const express = require("express");
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const { Pool } = require("pg");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const { downloadTikTok, listProfile, listAny } = require("./lib/tiktok");
const { burnCaption } = require("./lib/caption");
const { uniquify } = require("./lib/uniquify");
const { subtitle } = require("./lib/subtitles");
const { editVideo } = require("./lib/edit");
const { uploadFile, signedGetUrl } = require("./lib/storage");

const app = express();
app.use(express.json({ limit: "1mb" }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
  max: 3,
});

const WORKER_SECRET = process.env.WORKER_SECRET || "";
// Au-delà de ce délai, un job encore "processing" est considéré comme bloqué
// (worker redémarré / OOM) et repassé en erreur pour ne pas laisser l'UI tourner.
// 15 min : l'édition HD pleine durée peut être longue sur une petite instance.
const STALE_MS = 15 * 60 * 1000;

function tmp(name) {
  return path.join(os.tmpdir(), Date.now() + "_" + Math.random().toString(36).slice(2) + name);
}

// nettoie les emojis non supportés par la police (évite les carrés blancs)
function stripUnsupported(text) {
  return String(text || "").replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "").trim();
}

async function setJob(id, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `"${k}"=$${i + 2}`).join(", ");
  await pool.query(
    `UPDATE jobs SET ${sets}, updated_at=now() WHERE id=$1`,
    [id, ...keys.map((k) => fields[k])]
  );
}

async function getJob(id) {
  const { rows } = await pool.query("SELECT * FROM jobs WHERE id=$1", [id]);
  return rows[0];
}

// Écrit le job + ses métadonnées (légende, auteur…). Si la colonne `meta`
// n'existe pas encore (migration non appliquée), on réessaie sans, pour ne
// jamais bloquer un job à cause des métadonnées.
async function setJobMeta(id, fields, meta) {
  try {
    await setJob(id, meta ? { ...fields, meta: JSON.stringify(meta) } : fields);
  } catch (e) {
    if (/meta/i.test(String(e.message || ""))) await setJob(id, fields);
    else throw e;
  }
}

// Télécharge un objet du stockage vers un fichier local (streaming, faible mémoire).
async function pullInput(key, dest) {
  const url = await signedGetUrl(key, 600);
  const res = await fetch(url);
  if (!res.ok) throw new Error("Lecture input échouée: " + res.status);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
  return dest;
}

// ---- File d'attente séquentielle : un seul traitement lourd à la fois ----
let processing = false;
const queue = [];

function enqueue(jobId) {
  if (!queue.includes(jobId)) queue.push(jobId);
  drain();
}

async function drain() {
  if (processing) return;
  const jobId = queue.shift();
  if (!jobId) return;
  processing = true;
  try {
    await handleJob(jobId);
  } catch (e) {
    console.error("drain error", e);
  } finally {
    processing = false;
    // Laisse un instant à la libération mémoire avant le job suivant.
    setTimeout(drain, 250);
  }
}

async function handleJob(jobId) {
  let inFile, outFile;
  try {
    const job = await getJob(jobId);
    if (!job) throw new Error("job introuvable");
    if (job.status === "done") return; // déjà traité
    await setJob(jobId, { status: "processing" });

    const params = job.params || {};

    // profile : listing des vidéos d'un compte — résultat JSON, pas de vidéo.
    if (job.type === "profile") {
      const max = Math.min(parseInt(params.max, 10) || 24, 36);
      const data = await listAny(params.url, max);
      await setJobMeta(jobId, { status: "done" }, data);
      return;
    }

    outFile = tmp("_out.mp4");
    let outExt = "mp4"; // extension de sortie (mp4 par défaut, jpg/png pour une photo IG)
    let meta = null;

    if (job.type === "tiktok" || job.type === "instagram") {
      // yt-dlp gère TikTok comme Instagram (Reels ET posts photo publics) via l'URL.
      const dl = await downloadTikTok(params.url, os.tmpdir());
      inFile = dl.file;
      meta = dl.meta || null; // légende + auteur, affichés côté site
      if (dl.isImage) {
        // Post photo : on garde le fichier image tel quel (bon type/extension).
        outExt = dl.ext || "jpg";
        outFile = tmp("_out." + outExt);
      }
      fs.copyFileSync(inFile, outFile); // HD/qualité d'origine
    } else if (job.type === "edit") {
      // Édition « bot drive » : uniquisation + caption incrustée, HD 1080p.
      // Source = lien Instagram/TikTok (yt-dlp) OU fichier uploadé par le client.
      if (params.url) {
        const dl = await downloadTikTok(params.url, os.tmpdir());
        inFile = dl.file;
        meta = dl.meta || null;
      } else {
        inFile = tmp("_in.mp4");
        await pullInput(job.input_key, inFile);
      }
      await editVideo(inFile, outFile, {
        caption: stripUnsupported(params.caption),
        format: params.format,
        idx: 1,
        seed: (crypto.randomBytes(4).readUInt32BE(0) % 1e9) | 0,
      });
    } else {
      // caption / uniquify : l'input a été uploadé par le client dans le stockage
      inFile = tmp("_in.mp4");
      await pullInput(job.input_key, inFile);

      // Options communes : reformatage (9:16 / 4:5 / 1:1), filigrane, découpe (trim).
      const format = params.format;
      const watermark = stripUnsupported(params.watermark);
      const watermarkPos = params.watermarkPos;
      const trimStart = params.trimStart;
      const trimEnd = params.trimEnd;

      if (job.type === "caption") {
        await burnCaption(inFile, outFile, {
          caption: stripUnsupported(params.caption),
          position: params.position || "bottom",
          fontSize: params.fontSize || 48,
          format,
          watermark,
          watermarkPos,
          trimStart,
          trimEnd,
        });
      } else if (job.type === "uniquify") {
        await uniquify(inFile, outFile, {
          level: params.level || "light",
          seed: (crypto.randomBytes(4).readUInt32BE(0) % 1e9) | 0,
          format,
          watermark,
          watermarkPos,
          trimStart,
          trimEnd,
          flip: !!params.flip,
        });
      } else if (job.type === "subtitles") {
        await subtitle(inFile, outFile, {
          format,
          watermark,
          watermarkPos,
          trimStart,
          trimEnd,
          position: params.position || "bottom",
          language: params.language || "auto",
        });
      } else {
        throw new Error("type de job inconnu: " + job.type);
      }
    }

    const outKey = `outputs/${jobId}.${outExt}`;
    await uploadFile(outFile, outKey);
    await setJobMeta(jobId, { status: "done", output_key: outKey }, meta);
  } catch (e) {
    console.error("process error", e);
    try {
      await setJob(jobId, { status: "error", error: String(e.message || e).slice(0, 500) });
    } catch {}
  } finally {
    for (const f of [inFile, outFile]) {
      try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    }
  }
}

// Repasse en erreur les jobs restés "processing" trop longtemps (worker redémarré/OOM).
async function sweepStale() {
  try {
    await pool.query(
      `UPDATE jobs SET status='error',
         error='Traitement interrompu (mémoire limitée). Relance le job.',
         updated_at=now()
       WHERE status='processing'
         AND updated_at < now() - ($1::int * interval '1 millisecond')`,
      [STALE_MS]
    );
  } catch (e) {
    console.error("sweep error", e.message);
  }
}
setInterval(sweepStale, 60 * 1000);

app.get("/health", (_req, res) => res.json({ ok: true, busy: processing, queued: queue.length }));

// ---- Covoit229 : IA « Participation conseillée » ----
// Endpoint public (léger, lecture seule) partagé avec l'app de covoiturage.
// Utilise la clé Groq déjà configurée ici. CORS ouvert (appelé depuis la PWA).
function cors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "content-type");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
}
app.options("/suggest-contribution", (_req, res) => {
  cors(res);
  res.status(204).end();
});
app.post("/suggest-contribution", async (req, res) => {
  cors(res);
  try {
    const key = process.env.GROQ_API_KEY;
    if (!key) return res.status(500).json({ error: "config" });
    const { from, to, seats } = req.body || {};
    if (!from || !to) return res.status(400).json({ error: "from/to requis" });
    const nSeats = Math.max(1, Math.min(8, parseInt(seats, 10) || 1));

    // Prix RÉELS du Bénin (ajustables sans toucher au code, via variables Render).
    // Essence super à la POMPE (station) — officiel depuis le 1er mai 2026 : 725 FCFA/L.
    const FUEL = Number(process.env.FUEL_PRICE_FCFA) || 725; // FCFA / litre
    const CONS = Number(process.env.FUEL_CONS_L_100) || 8; // L / 100 km (voiture mixte)

    // L'IA ne sert QU'À estimer la DISTANCE routière (elle connaît le Bénin).
    // Le montant est calculé ICI à partir du vrai prix station → réaliste et stable.
    const sys =
      "Tu es un estimateur de DISTANCE routière au Bénin (Cotonou et villes du pays). " +
      "Donne la distance routière réaliste en kilomètres entre deux lieux. " +
      'Réponds STRICTEMENT en JSON : {"distance_km": number}.';
    const user = `Distance routière de « ${from} » à « ${to} » au Bénin, en km.`;

    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
      }),
    });
    if (!r.ok) return res.status(502).json({ error: "ia_indisponible" });
    const data = await r.json();
    let p = {};
    try {
      p = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}");
    } catch {
      p = {};
    }

    // Distance estimée (bornée pour éviter les valeurs aberrantes).
    let distanceKm = Number(p.distance_km) || 0;
    if (!(distanceKm > 0)) distanceKm = 5;
    distanceKm = Math.min(distanceKm, 1200);

    // Coût carburant de l'ALLER SIMPLE, réparti entre les PASSAGERS (mode conservé).
    const round100 = (n) => Math.max(0, Math.round((Number(n) || 0) / 100) * 100);
    const fuelCost = distanceKm * (CONS / 100) * FUEL;
    const total = round100(fuelCost);
    const perSeat = round100(fuelCost / nSeats);
    const distTxt = Math.round(distanceKm);

    res.json({
      distanceKm: distTxt,
      total,
      perSeat,
      rationale:
        `≈ ${distTxt} km · essence ${FUEL} FCFA/L à la pompe · ~${CONS} L/100 km · ` +
        `carburant de l'aller partagé entre ${nSeats} passager${nSeats > 1 ? "s" : ""}.`,
    });
  } catch (e) {
    res.status(400).json({ error: "bad_request" });
  }
});

app.post("/process", async (req, res) => {
  if (WORKER_SECRET && req.headers["x-worker-secret"] !== WORKER_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const { jobId } = req.body || {};
  if (!jobId) return res.status(400).json({ error: "jobId requis" });
  // On répond tout de suite : le traitement se fait en arrière-plan, un à la fois.
  res.json({ accepted: true, queued: queue.length + (processing ? 1 : 0) });
  enqueue(jobId);
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log("worker en écoute sur :" + port);
  // Nettoyage initial : les jobs "processing" d'avant le redémarrage sont orphelins.
  sweepStale();
});
