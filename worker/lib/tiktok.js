// tiktok.js — télécharge une vidéo (TikTok, Instagram… tout ce que gère yt-dlp) en HD
// sans watermark, et récupère les métadonnées (légende, auteur, lien du profil).
// Fournit aussi listProfile() pour énumérer les vidéos d'un compte.
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("yt-dlp", args);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error("yt-dlp a échoué: " + err.slice(-800)));
    });
    p.on("error", reject);
  });
}

/**
 * Télécharge une URL en meilleure qualité et retourne le fichier + les métadonnées.
 * @returns {Promise<{file:string, title:string, meta:object}>}
 */
function downloadTikTok(url, outDir) {
  if (!/^https?:\/\//i.test(url)) return Promise.reject(new Error("URL invalide"));
  const id = "tt_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
  const outTpl = path.join(outDir, id + ".%(ext)s");

  const args = [
    "-f", "bv*+ba/b",
    "-S", "res,br", // meilleure résolution puis débit (HD garanti quand dispo)
    "--merge-output-format", "mp4",
    "--no-playlist",
    "--no-warnings",
    "--restrict-filenames",
    "--write-info-json", // pour récupérer légende + auteur
    "-o", outTpl,
    url,
  ];

  return run(args).then(() => {
    const files = fs.readdirSync(outDir);
    const vid = files.find((n) => n.startsWith(id + ".") && !n.endsWith(".info.json"));
    if (!vid) throw new Error("Fichier téléchargé introuvable");

    let meta = {};
    try {
      const infoName = files.find((n) => n.startsWith(id) && n.endsWith(".info.json"));
      if (infoName) {
        const info = JSON.parse(fs.readFileSync(path.join(outDir, infoName), "utf8"));
        meta = {
          caption: String(info.description || info.title || "").slice(0, 2200),
          author: info.uploader || info.uploader_id || info.channel || "",
          authorUrl: info.uploader_url || info.channel_url || "",
          sourceUrl: info.webpage_url || url,
        };
        try { fs.unlinkSync(path.join(outDir, infoName)); } catch {}
      }
    } catch {}

    return { file: path.join(outDir, vid), title: id, meta };
  });
}

/**
 * Énumère (au mieux) les vidéos d'un profil TikTok/Instagram. Fragile : ces plateformes
 * bloquent souvent ce type de listing. Retourne { author, authorUrl, videos:[{url,id,title,thumbnail}] }.
 */
function listProfile(url, max = 24) {
  if (!/^https?:\/\//i.test(url)) return Promise.reject(new Error("URL invalide"));
  const args = [
    "--flat-playlist",
    "--dump-single-json",
    "--no-warnings",
    "--playlist-end", String(max),
    url,
  ];
  return run(args).then((out) => {
    const data = JSON.parse(out);
    const entries = Array.isArray(data.entries) ? data.entries : [];
    return {
      author: data.uploader || data.title || "",
      authorUrl: data.uploader_url || data.webpage_url || url,
      videos: entries
        .slice(0, max)
        .map((e) => ({
          url: e.url || e.webpage_url || "",
          id: e.id || "",
          title: String(e.title || "").slice(0, 140),
          thumbnail:
            (e.thumbnails && e.thumbnails.length
              ? e.thumbnails[e.thumbnails.length - 1].url
              : e.thumbnail) || "",
        }))
        .filter((v) => /^https?:\/\//i.test(v.url)),
    };
  });
}

module.exports = { downloadTikTok, listProfile };
