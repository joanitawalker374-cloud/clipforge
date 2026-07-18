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

const { downloadTikTok } = require("./lib/tiktok");
const { burnCaption } = require("./lib/caption");
const { uniquify } = require("./lib/uniquify");
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
const STALE_MS = 3 * 60 * 1000;

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
    outFile = tmp("_out.mp4");

    if (job.type === "tiktok") {
      const { file } = await downloadTikTok(params.url, os.tmpdir());
      inFile = file;
      fs.copyFileSync(inFile, outFile); // HD tel quel
    } else {
      // caption / uniquify : l'input a été uploadé par le client dans le stockage
      inFile = tmp("_in.mp4");
      await pullInput(job.input_key, inFile);

      // Options communes : reformatage (9:16 / 4:5 / 1:1) et filigrane texte.
      const format = params.format;
      const watermark = stripUnsupported(params.watermark);
      const watermarkPos = params.watermarkPos;

      if (job.type === "caption") {
        await burnCaption(inFile, outFile, {
          caption: stripUnsupported(params.caption),
          position: params.position || "bottom",
          fontSize: params.fontSize || 48,
          format,
          watermark,
          watermarkPos,
        });
      } else if (job.type === "uniquify") {
        await uniquify(inFile, outFile, {
          level: params.level || "light",
          seed: (crypto.randomBytes(4).readUInt32BE(0) % 1e9) | 0,
          format,
          watermark,
          watermarkPos,
        });
      } else {
        throw new Error("type de job inconnu: " + job.type);
      }
    }

    const outKey = `outputs/${jobId}.mp4`;
    await uploadFile(outFile, outKey);
    await setJob(jobId, { status: "done", output_key: outKey });
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
