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
    // vidéo HD si dispo, SINON meilleure image (posts photo Instagram).
    "-f", "bv*+ba/b/best",
    "-S", "res,br", // meilleure résolution puis débit (HD garanti quand dispo)
    "--merge-output-format", "mp4", // (ignoré pour une image seule)
    "--no-playlist",
    "--no-warnings",
    "--restrict-filenames",
    "--write-info-json", // pour récupérer légende + auteur
    "-o", outTpl,
    url,
  ];

  return run(args).catch((err) => {
    // Les POSTS PHOTO Instagram ne sont pas gérés par yt-dlp (« No video
    // formats found ») : on bascule sur la page embed d'Instagram, prévue
    // pour l'affichage anonyme sur des sites tiers.
    if (/instagram\.com/i.test(url) && /No video formats found/i.test(String(err && err.message))) {
      return igEmbedPhoto(url, outDir).then((res) => ({ __photo: res }));
    }
    throw err;
  }).then((maybe) => {
    if (maybe && maybe.__photo) return maybe.__photo;
    const files = fs.readdirSync(outDir);
    const media = files.find((n) => n.startsWith(id + ".") && !n.endsWith(".info.json"));
    if (!media) throw new Error("Fichier téléchargé introuvable");
    const ext = path.extname(media).replace(".", "").toLowerCase() || "mp4";
    const isImage = ["jpg", "jpeg", "png", "webp", "heic"].includes(ext);

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

    return { file: path.join(outDir, media), title: id, ext, isImage, meta };
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
          // Statistiques (TikTok expose souvent ces compteurs dans le listing).
          views: toNum(e.view_count),
          likes: toNum(e.like_count),
          comments: toNum(e.comment_count),
          isImage: false,
        }))
        .filter((v) => /^https?:\/\//i.test(v.url)),
    };
  });
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Télécharge la PHOTO d'un post Instagram via la page embed (accès anonyme
 * prévu pour les sites tiers — bien moins bloquée que le site principal).
 * Gère /p/<code>/ et /reel/<code>/ ; pour un carrousel, prend la 1ère image.
 */
async function igEmbedPhoto(url, outDir) {
  const m = String(url).match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|tv)\/([A-Za-z0-9_-]+)/i);
  if (!m) throw new Error("Lien de post Instagram invalide");
  const sc = m[1];
  const res = await fetch("https://www.instagram.com/p/" + sc + "/embed/captioned/", {
    headers: {
      "User-Agent": BROWSER_UA,
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://www.instagram.com/",
    },
  });
  if (!res.ok) throw new Error("Instagram a refusé l'accès au post (HTTP " + res.status + ")");
  const html = await res.text();

  let img = null;
  let mm = html.match(/"display_url"\s*:\s*"((?:[^"\\]|\\.)+)"/);
  if (mm) {
    try { img = JSON.parse('"' + mm[1] + '"'); } catch {}
  }
  if (!img) {
    mm = html.match(/class="EmbeddedMediaImage"[^>]*src="([^"]+)"/);
    if (mm) img = mm[1].replace(/&amp;/g, "&");
  }
  if (!img) throw new Error("Photo introuvable (post privé, supprimé, ou vidéo uniquement).");

  const r2 = await fetch(img, {
    headers: { "User-Agent": BROWSER_UA, Referer: "https://www.instagram.com/" },
  });
  if (!r2.ok) throw new Error("Téléchargement de la photo refusé (HTTP " + r2.status + ")");
  const buf = Buffer.from(await r2.arrayBuffer());
  const file = path.join(outDir, "ig_" + Date.now() + "_" + Math.floor(Math.random() * 1e6) + ".jpg");
  fs.writeFileSync(file, buf);

  // Légende + auteur (best effort) depuis la page embed.
  let caption = "";
  mm = html.match(/class="Caption"[^>]*>([\s\S]*?)<\/div>/);
  if (mm) {
    caption = mm[1]
      .replace(/<br[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .trim()
      .slice(0, 2200);
  }
  let author = "";
  mm = html.match(/class="UsernameText"[^>]*>([^<]+)</);
  if (mm) author = mm[1].trim();

  return {
    file,
    title: "ig_" + sc,
    ext: "jpg",
    isImage: true,
    meta: {
      caption,
      author,
      authorUrl: author ? "https://www.instagram.com/" + author + "/" : "",
      sourceUrl: url,
    },
  };
}

/**
 * Liste les publications RÉCENTES d'un compte Instagram (posts, reels, photos)
 * via l'API web publique d'Instagram, AVEC les statistiques (vues + likes).
 * Instagram limite l'accès anonyme : si l'IP est bloquée, on lève une erreur
 * claire et le site affiche un message de repli.
 */
async function listInstagram(url, max = 24) {
  const m = String(url).match(/instagram\.com\/(?:stories\/)?([A-Za-z0-9_.]+)\/?/i);
  const username = m && m[1] ? m[1] : "";
  const blocked = new Set(["p", "reel", "reels", "tv", "explore", "accounts", "stories"]);
  if (!username || blocked.has(username.toLowerCase())) {
    throw new Error("Lien de compte Instagram invalide (ex. https://www.instagram.com/nom_du_compte/)");
  }

  const headers = {
    "User-Agent": BROWSER_UA,
    "X-IG-App-ID": "936619743392459",
    "X-Requested-With": "XMLHttpRequest",
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://www.instagram.com/" + username + "/",
  };

  // Deux hôtes d'API : www (site web) puis i.instagram.com (API mobile),
  // souvent plus permissif quand le premier bloque l'IP du serveur.
  const hosts = [
    "https://www.instagram.com/api/v1/users/web_profile_info/?username=",
    "https://i.instagram.com/api/v1/users/web_profile_info/?username=",
  ];
  let json = null;
  let lastStatus = 0;
  for (const base of hosts) {
    try {
      const res = await fetch(base + encodeURIComponent(username), { headers });
      lastStatus = res.status;
      if (res.status === 404) throw new Error("Compte Instagram introuvable.");
      if (res.ok) {
        json = await res.json();
        if (json && json.data && json.data.user) break;
        json = null;
      }
    } catch (e) {
      if (/introuvable/.test(String(e && e.message))) throw e;
      // sinon on tente l'hôte suivant
    }
  }
  if (!json) {
    throw new Error(
      "Instagram a refusé la requête (HTTP " +
        (lastStatus || "?") +
        "). L'accès à la liste d'un compte est restreint par Instagram."
    );
  }
  const user = json.data.user;
  if (!user) throw new Error("Réponse Instagram inattendue (compte privé ?).");

  const edges =
    (user.edge_owner_to_timeline_media && user.edge_owner_to_timeline_media.edges) || [];
  const videos = edges
    .slice(0, max)
    .map((edge) => {
      const n = edge.node || {};
      const shortcode = n.shortcode || n.code || "";
      const isVideo = !!n.is_video || n.__typename === "GraphVideo";
      const capEdges =
        (n.edge_media_to_caption && n.edge_media_to_caption.edges) || [];
      const caption =
        capEdges.length && capEdges[0].node ? String(capEdges[0].node.text || "") : "";
      const likes =
        (n.edge_media_preview_like && n.edge_media_preview_like.count) ??
        (n.edge_liked_by && n.edge_liked_by.count);
      const comments = n.edge_media_to_comment && n.edge_media_to_comment.count;
      return {
        url: shortcode ? "https://www.instagram.com/p/" + shortcode + "/" : "",
        id: shortcode,
        title: caption.slice(0, 140),
        thumbnail: n.thumbnail_src || n.display_url || "",
        views: isVideo ? toNum(n.video_view_count) : null,
        likes: toNum(likes),
        comments: toNum(comments),
        isImage: !isVideo,
      };
    })
    .filter((v) => /^https?:\/\//i.test(v.url));

  return {
    author: user.full_name || user.username || username,
    authorUrl: "https://www.instagram.com/" + (user.username || username) + "/",
    videos,
  };
}

/** Aiguillage : Instagram → API web ; sinon (TikTok…) → yt-dlp. */
function listAny(url, max = 24) {
  if (/instagram\.com/i.test(url)) return listInstagram(url, max);
  return listProfile(url, max);
}

module.exports = { downloadTikTok, listProfile, listInstagram, listAny };
