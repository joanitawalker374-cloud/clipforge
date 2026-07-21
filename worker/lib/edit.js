// edit.js — mode « édition » du bot drive, porté sur ClipForge.
// Reproduit ce que fait producer.py (dépôt agence) : chaque vidéo est
//   1) rendue UNIQUE ("respoof" : léger crop/zoom, teinte, saturation,
//      contraste, luminosité, vitesse ±, métadonnées effacées),
//   2) sa CAPTION est incrustée façon "bash vidéo" : sous-titre ASS blanc
//      gras CENTRÉ verticalement, avec une ombre floue noire (glow),
// puis ré-encodée proprement. Différences voulues côté site (choix de NATHAN) :
//   • vidéo ENTIÈRE (pas de coupe à 6 s),
//   • sortie HD (jusqu'à 1080p, sans upscaler), crf 20 (meilleure qualité).
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { formatFilter, FORMATS } = require("./media");

// Police de la caption (installée dans l'image via fonts-liberation).
const CAPTION_FONT = "Liberation Sans";
const CAPTION_BOLD = true;
const CAPTION_SHADOW_ALPHA = "70"; // transparence de l'ombre (hex ASS, 00=opaque)
const CAPTION_SHADOW_SIZE = 0.07; // épaisseur du glow relative à la police
const CAPTION_SHADOW_BLUR = 6; // flou du glow
const CAPTION_CENTER = 0.5; // position verticale (0.5 = centre)

// Retire les emojis (la police n'a pas ces glyphes → carrés blancs sinon).
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{FE00}-\u{FE0F}\u{200D}\u{24C2}\u{2122}\u{2139}]/gu;

// PRNG déterministe (mulberry32) pour des variations reproductibles par "seed".
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, min, max) => min + r() * (max - min);

// Dimensions de la vidéo source (défaut 1080x1920 si échec).
function probeDims(input) {
  try {
    const out = spawnSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height", "-of", "json", input,
    ]);
    const s = JSON.parse(out).streams[0];
    return { w: parseInt(s.width, 10), h: parseInt(s.height, 10) };
  } catch {
    return { w: 1080, h: 1920 };
  }
}

function hasAudio(input) {
  try {
    const out = spawnSync("ffprobe", [
      "-v", "quiet", "-print_format", "json", "-show_streams", input,
    ]);
    return (JSON.parse(out || "{}").streams || []).some((s) => s.codec_type === "audio");
  } catch {
    return false;
  }
}

// ffprobe synchrone minimal (petite sortie, sûr en mémoire).
function spawnSync(cmd, args) {
  const { execFileSync } = require("child_process");
  return execFileSync(cmd, args, { encoding: "utf8", timeout: 60000 });
}

// Échappe le texte pour l'intérieur d'un événement ASS.
function assEscape(text) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\n/g, "\\N");
}

// Échappe le chemin du .ass pour le filtre subtitles= de ffmpeg.
function assSubPath(p) {
  let s = path.resolve(p).replace(/\\/g, "/");
  for (const [ch, rep] of [[":", "\\:"], [",", "\\,"], ["[", "\\["], ["]", "\\]"], ["'", "\\'"]]) {
    s = s.split(ch).join(rep);
  }
  return s;
}

// Taille de police selon largeur + nombre de lignes (comme producer.py).
function captionFontSize(w, nLines) {
  let frac;
  if (nLines <= 2) frac = 0.078;
  else if (nLines <= 4) frac = 0.062;
  else if (nLines <= 6) frac = 0.052;
  else frac = 0.044;
  return Math.max(29, Math.round(w * frac));
}

// Coupe une caption longue en lignes d'environ maxChars caractères.
function wrapCaption(text, maxChars = 30) {
  const words = String(text).split(/\s+/).filter(Boolean);
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

// Construit le fichier .ass (deux calques : glow flou dessous, texte blanc dessus)
// et renvoie le filtre subtitles=... . null si pas de texte.
function buildCaptionFilter(caption, workDir, idx, w, h) {
  let clean = String(caption || "").replace(EMOJI_RE, "");
  clean = clean
    .split("\n")
    .map((ln) => ln.split(/\s+/).filter(Boolean).join(" "))
    .join("\n")
    .trim();
  if (!clean) return null;
  clean = wrapCaption(clean, 30);

  const nLines = clean.split("\n").length;
  const fs2 = captionFontSize(w, nLines);
  const cx = w / 2;
  const cy = h * CAPTION_CENTER;
  const bold = CAPTION_BOLD ? -1 : 0;
  const mlr = Math.round(w * 0.06);
  const text = assEscape(clean);
  const pos = `\\an5\\pos(${cx.toFixed(0)},${cy.toFixed(0)})`;
  const gb = Math.max(2, Math.round(fs2 * CAPTION_SHADOW_SIZE));
  const glow =
    `${pos}\\bord${gb}\\shad0\\blur${CAPTION_SHADOW_BLUR}` +
    `\\1c&H000000&\\3c&H000000&\\1a&H${CAPTION_SHADOW_ALPHA}&\\3a&H${CAPTION_SHADOW_ALPHA}&`;
  const top = `${pos}\\bord0\\shad0\\blur0\\1c&HFFFFFF&\\1a&H00&`;

  const ass =
    "[Script Info]\n" +
    "ScriptType: v4.00+\n" +
    `PlayResX: ${w}\nPlayResY: ${h}\n` +
    "WrapStyle: 0\nScaledBorderAndShadow: yes\nYCbCr Matrix: TV.709\n\n" +
    "[V4+ Styles]\n" +
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, " +
    "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, " +
    "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
    `Style: Default,${CAPTION_FONT},${fs2},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,` +
    `${bold},0,0,0,100,100,0,0,1,0,0,5,${mlr},${mlr},0,1\n\n` +
    "[Events]\n" +
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" +
    `Dialogue: 0,0:00:00.00,9:59:59.00,Default,,0,0,0,,{${glow}}${text}\n` +
    `Dialogue: 1,0:00:00.00,9:59:59.00,Default,,0,0,0,,{${top}}${text}\n`;

  const ap = path.join(workDir, `cap_${idx}.ass`);
  fs.writeFileSync(ap, "﻿" + ass, { encoding: "utf8" });
  return `subtitles='${assSubPath(ap)}'`;
}

/**
 * Édite une vidéo : uniquisation (respoof) + caption incrustée, sortie HD.
 * @param {string} input
 * @param {string} output
 * @param {object} opts { caption, seed, format }  format: '9:16'|'4:5'|'1:1'|undefined
 */
function editVideo(input, output, opts = {}) {
  const seed = (opts.seed ?? Math.floor(Date.now() % 1e9)) | 0;
  const r = rng(seed);

  // Dimensions servant à dimensionner la caption : celles du format cible si
  // reformatage demandé, sinon celles de la source.
  let capW, capH;
  if (opts.format && FORMATS[opts.format]) {
    [capW, capH] = FORMATS[opts.format];
  } else {
    const d = probeDims(input);
    capW = d.w;
    capH = d.h;
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "edit_"));

  // Micro-transformations d'unicité (imperceptibles) — mêmes plages que le respoof du bot.
  const zoom = pick(r, 1.012, 1.028);
  const sat = pick(r, 0.97, 1.03);
  const contrast = pick(r, 0.98, 1.02);
  const bright = pick(r, -0.015, 0.015);
  const hue = pick(r, -3, 3);
  const noise = Math.floor(pick(r, 2, 6));
  const speed = pick(r, 0.98, 1.02);

  const device = ["iPhone 14", "iPhone 15 Pro", "Pixel 8", "Galaxy S23", "iPhone 13"][
    Math.floor(r() * 5)
  ];
  const iso = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  const cf = buildCaptionFilter(opts.caption, workDir, opts.idx || 0, capW, capH);

  // Chaîne de filtres : reformatage éventuel → unicité → caption → HD (≤1080p).
  const vf = [
    opts.format ? formatFilter(opts.format) : null,
    `scale=iw*${zoom.toFixed(4)}:ih*${zoom.toFixed(4)}`,
    `crop=iw/${zoom.toFixed(4)}:ih/${zoom.toFixed(4)}`,
    `eq=contrast=${contrast.toFixed(4)}:brightness=${bright.toFixed(4)}:saturation=${sat.toFixed(4)}`,
    `hue=h=${hue.toFixed(2)}`,
    noise > 0 ? `noise=alls=${noise}:allf=t` : null,
    `setpts=${(1 / speed).toFixed(5)}*PTS`,
    cf,
    // HD sans upscaler : plafonne la hauteur à 1920 (≈1080p vertical), largeur paire auto.
    `scale=-2:'min(ih,1920)'`,
  ]
    .filter(Boolean)
    .join(",");

  const meta = [
    "-map_metadata", "-1",
    "-metadata", `creation_time=${iso}`,
    "-metadata", `com.apple.quicktime.make=${device.includes("iPhone") ? "Apple" : "Android"}`,
    "-metadata", `com.apple.quicktime.model=${device}`,
    "-metadata", "encoder=clipforge",
  ];

  const args = ["-y", "-threads", "1", "-i", input, "-vf", vf];
  if (hasAudio(input)) {
    args.push("-af", `atempo=${speed.toFixed(5)}`, "-c:a", "aac", "-b:a", "160k");
  } else {
    args.push("-an");
  }
  args.push(
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    ...meta,
    "-movflags", "+faststart",
    output
  );

  return runFfmpeg(args)
    .then(() => ({ seed, device }))
    .finally(() => {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {}
    });
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

module.exports = { editVideo };
