// media.js — helpers partagés pour le reformatage (ratios réseaux) et le filigrane.
// Utilisés par caption.js et uniquify.js. Aucune dépendance externe.
const path = require("path");

const FONT = path.join(__dirname, "..", "assets", "font.ttf");

// Dimensions cibles par format (base 1080, ratios courants Insta/Threads/TikTok).
const FORMATS = {
  "9:16": [1080, 1920], // Reels / TikTok / Stories
  "4:5": [1080, 1350], // feed portrait Instagram
  "1:1": [1080, 1080], // feed carré
};

// Filtre de recadrage « cover + crop centré » vers un format donné.
// Remplit tout le cadre sans bandes noires (léger rognage des bords).
// Retourne null pour "original" ou format inconnu (pas de reformatage).
function formatFilter(format) {
  const dim = FORMATS[format];
  if (!dim) return null;
  const [w, h] = dim;
  return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;
}

// Échappe le texte pour le filtre drawtext de ffmpeg (niveaux filtergraph + drawtext).
function escapeDrawText(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "’") // apostrophe typographique -> évite de casser le filtre
    .replace(/%/g, "\\%")
    .replace(/,/g, "\\,"); // la virgule sépare les filtres : on l'échappe
}

// Filtre filigrane (texte discret dans un coin).
// position: 'br' (défaut) | 'bl' | 'tr' | 'tl'. Retourne null si texte vide.
function watermarkFilter(text, position = "br") {
  const t = String(text || "").trim();
  if (!t) return null;
  const pad = 26;
  const pos =
    {
      br: `x=w-tw-${pad}:y=h-th-${pad}`,
      bl: `x=${pad}:y=h-th-${pad}`,
      tr: `x=w-tw-${pad}:y=${pad}`,
      tl: `x=${pad}:y=${pad}`,
    }[position] || `x=w-tw-${pad}:y=h-th-${pad}`;

  return [
    `drawtext=fontfile='${FONT.replace(/\\/g, "/")}'`,
    `text='${escapeDrawText(t)}'`,
    `fontcolor=white@0.85`,
    `fontsize=h/28`,
    `shadowcolor=black@0.5`,
    `shadowx=2`,
    `shadowy=2`,
    pos,
  ].join(":");
}

module.exports = { FONT, FORMATS, formatFilter, watermarkFilter, escapeDrawText };
