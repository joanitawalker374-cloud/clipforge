// index.js — worker HTTP. Reçoit un jobId, traite la vidéo, dépose le résultat,
// met à jour la ligne `jobs` en base. Sécurisé par un secret partagé (WORKER_SECRET).
const express = require("express");
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const { Pool } = require("pg");

const { downloadTikTok } = require("./lib/tiktok");
const { burnCaption } = require("./lib/caption");
const { uniquify } = require("./lib/uniquify");
const { uploadFile, signedGetUrl } = require("./lib/storage");

const app = express();
app.use(express.json({ limit: "1mb" }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
});

const WORKER_SECRET = process.env.WORKER_SECRET || "";

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

// Télécharge un objet du stockage vers un fichier local (via URL signée).
async function pullInput(key, dest) {
  const url = await signedGetUrl(key, 600);
  const res = await fetch(url);
  if (!res.ok) throw new Error("Lecture input échouée: " + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return dest;
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/process", async (req, res) => {
  if (WORKER_SECRET && req.headers["x-worker-secret"] !== WORKER_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const { jobId } = req.body || {};
  if (!jobId) return res.status(400).json({ error: "jobId requis" });
  // On répond tout de suite : le traitement se fait en arrière-plan.
  res.json({ accepted: true });

  let inFile, outFile;
  try {
    const job = await getJob(jobId);
    if (!job) throw new Error("job introuvable");
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

      if (job.type === "caption") {
        await burnCaption(inFile, outFile, {
          caption: stripUnsupported(params.caption),
          position: params.position || "bottom",
          fontSize: params.fontSize || 48,
        });
      } else if (job.type === "uniquify") {
        await uniquify(inFile, outFile, {
          level: params.level || "light",
          seed: (crypto.randomBytes(4).readUInt32BE(0) % 1e9) | 0,
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
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("worker en écoute sur :" + port));
