// tiktok.js — télécharge une vidéo TikTok en HD sans watermark via yt-dlp.
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

/**
 * Télécharge un TikTok (ou autre URL supportée par yt-dlp) en meilleure qualité.
 * @param {string} url
 * @param {string} outDir  dossier de sortie
 * @returns {Promise<{file:string, title:string}>}
 */
function downloadTikTok(url, outDir) {
  if (!/^https?:\/\//i.test(url)) {
    return Promise.reject(new Error("URL invalide"));
  }
  const id = "tt_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
  const outTpl = path.join(outDir, id + ".%(ext)s");

  const args = [
    // meilleure qualité mp4 possible, fusion audio+vidéo
    "-f", "bv*+ba/b",
    "--merge-output-format", "mp4",
    "--no-playlist",
    "--no-warnings",
    "--restrict-filenames",
    "-o", outTpl,
    url,
  ];

  return new Promise((resolve, reject) => {
    const p = spawn("yt-dlp", args);
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.stdout.on("data", () => {});
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error("yt-dlp a échoué: " + err.slice(-800)));
      // retrouver le fichier produit
      const f = fs.readdirSync(outDir).find((n) => n.startsWith(id + "."));
      if (!f) return reject(new Error("Fichier téléchargé introuvable"));
      resolve({ file: path.join(outDir, f), title: id });
    });
    p.on("error", reject);
  });
}

module.exports = { downloadTikTok };
