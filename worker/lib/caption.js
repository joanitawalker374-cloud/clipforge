// caption.js — incruste une légende propre sur une vidéo (style "clean", type Reel/TikTok).
// Utilise ffmpeg drawtext. La police est fournie dans worker/assets/font.ttf.
// Options en plus : reformatage (9:16 / 4:5 / 1:1) et filigrane texte.
const { spawn } = require("child_process");
const {
  FONT,
  formatFilter,
  watermarkFilter,
  escapeDrawText,
} = require("./media");

// Découpe la légende en lignes d'environ maxChars caractères (retour à la ligne propre).
function wrap(text, maxChars = 28) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > maxChars) {
      if (line) lines.push(line.trim());
      line = w;
    } else {
      line = (line + " " + w).trim();
    }
  }
  if (line) lines.push(line.trim());
  return lines.join("\n");
}

// Construit le filtre drawtext de la légende (ou null s'il n'y a pas de texte).
function captionFilter(opts) {
  const caption = wrap(opts.caption || "", opts.wrap || 28);
  if (!caption.trim()) return null;
  const position = opts.position || "bottom";
  const fontSize = opts.fontSize || 48;

  // y selon la position demandée (h = hauteur vidéo, th = hauteur du texte)
  const yByPos = {
    top: "h*0.08",
    center: "(h-th)/2",
    bottom: "h*0.80-th",
  };
  const y = yByPos[position] || yByPos.bottom;

  return [
    `drawtext=fontfile='${FONT.replace(/\\/g, "/")}'`,
    `text='${escapeDrawText(caption)}'`,
    `fontcolor=white`,
    `fontsize=${fontSize}`,
    `line_spacing=10`,
    `x=(w-tw)/2`,
    `y=${y}`,
    `box=1`,
    `boxcolor=black@${opts.boxOpacity ?? 0.45}`,
    `boxborderw=24`,
    `shadowcolor=black@0.6`,
    `shadowx=2`,
    `shadowy=2`,
  ].join(":");
}

/**
 * Incruste une légende (+ options) sur la vidéo.
 * @param {string} input  chemin vidéo source
 * @param {string} output chemin vidéo de sortie
 * @param {object} opts   { caption, position, fontSize, format, watermark, watermarkPos }
 */
function burnCaption(input, output, opts = {}) {
  // Ordre : reformatage d'abord, puis légende, puis filigrane
  // (positionnés par rapport au cadre final).
  const vf = [
    formatFilter(opts.format),
    captionFilter(opts),
    watermarkFilter(opts.watermark, opts.watermarkPos),
  ].filter(Boolean);

  const filter = vf.length ? vf.join(",") : "null";

  const args = [
    "-y",
    "-threads", "1",
    "-i", input,
    "-vf", filter,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-c:a", "copy",
    "-movflags", "+faststart",
    output,
  ];
  return runFfmpeg(args);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args);
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("ffmpeg exited " + code + "\n" + err.slice(-1500)));
    });
    p.on("error", reject);
  });
}

module.exports = { burnCaption, wrap, runFfmpeg };
