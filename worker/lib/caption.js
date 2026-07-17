// caption.js — incruste une légende propre sur une vidéo (style "clean", type Reel/TikTok).
// Utilise ffmpeg drawtext. La police est fournie dans worker/assets/font.ttf.
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const FONT = path.join(__dirname, "..", "assets", "font.ttf");

// Échappe le texte pour le filtre drawtext de ffmpeg.
function escapeDrawText(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "’") // apostrophe typographique -> évite de casser le filtre
    .replace(/%/g, "\\%");
}

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

/**
 * Incruste une légende sur la vidéo.
 * @param {string} input  chemin vidéo source
 * @param {string} output chemin vidéo de sortie
 * @param {object} opts   { caption, position: 'top'|'center'|'bottom', fontSize, boxOpacity }
 */
function burnCaption(input, output, opts = {}) {
  const caption = wrap(opts.caption || "", opts.wrap || 28);
  const position = opts.position || "bottom";
  const fontSize = opts.fontSize || 48;

  // y selon la position demandée (h = hauteur vidéo, th = hauteur du texte)
  const yByPos = {
    top: "h*0.08",
    center: "(h-th)/2",
    bottom: "h*0.80-th",
  };
  const y = yByPos[position] || yByPos.bottom;

  const draw = [
    `fontfile='${FONT.replace(/\\/g, "/")}'`,
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

  const args = [
    "-y",
    "-i", input,
    "-vf", `drawtext=${draw}`,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
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
