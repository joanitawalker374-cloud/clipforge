// subtitles.js — sous-titres automatiques.
// 1) découpe éventuelle, 2) extraction audio, 3) transcription via l'API Groq
// (Whisper, offre gratuite), 4) incrustation des sous-titres horodatés avec drawtext
// (par segment, enable='between(t,...)') + reformatage + filigrane.
// Aucune dépendance externe (pas de libass) : on réutilise drawtext, toujours dispo.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  FONT,
  formatFilter,
  watermarkFilter,
  escapeDrawText,
  trimArgs,
} = require("./media");

const GROQ_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_WHISPER_MODEL || "whisper-large-v3-turbo";

function tmp(name) {
  return path.join(os.tmpdir(), Date.now() + "_" + Math.random().toString(36).slice(2) + name);
}

// Découpe le texte d'un segment en lignes courtes (lisible en vertical).
function wrap(text, maxChars = 30) {
  const words = String(text).trim().split(/\s+/);
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

// Transcrit un fichier audio via l'API Groq (compatible OpenAI). Retourne des segments {start,end,text}.
async function transcribe(audioPath, language) {
  if (!GROQ_KEY) {
    throw new Error(
      "GROQ_API_KEY manquant : ajoute ta clé Groq gratuite dans les variables d'environnement du worker."
    );
  }
  const buf = fs.readFileSync(audioPath);
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "audio/mpeg" }), "audio.mp3");
  form.append("model", GROQ_MODEL);
  form.append("response_format", "verbose_json");
  if (language && language !== "auto") form.append("language", language);

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_KEY}` },
    body: form,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error("Transcription Groq " + res.status + " : " + t.slice(0, 200));
  }
  const j = await res.json();
  return Array.isArray(j.segments) ? j.segments : [];
}

// Construit un filtre drawtext par segment (sous-titre horodaté).
function subtitleFilters(segments, opts) {
  const fontSize = opts.fontSize || 46;
  const yByPos = {
    top: "h*0.10",
    center: "(h-th)/2",
    bottom: "h*0.82-th",
  };
  const y = yByPos[opts.position] || yByPos.bottom;

  return segments
    .map((seg) => {
      const raw = wrap(String(seg.text || ""), opts.wrap || 30);
      const txt = escapeDrawText(raw);
      if (!raw.trim()) return null;
      const start = Number(seg.start || 0).toFixed(2);
      const end = Number(seg.end || 0).toFixed(2);
      if (!(Number(end) > Number(start))) return null;
      return [
        `drawtext=fontfile='${FONT.replace(/\\/g, "/")}'`,
        `text='${txt}'`,
        `fontcolor=white`,
        `fontsize=${fontSize}`,
        `line_spacing=8`,
        `x=(w-tw)/2`,
        `y=${y}`,
        `box=1`,
        `boxcolor=black@${opts.boxOpacity ?? 0.5}`,
        `boxborderw=22`,
        `shadowcolor=black@0.6`,
        `shadowx=2`,
        `shadowy=2`,
        `enable='between(t,${start},${end})'`,
      ].join(":");
    })
    .filter(Boolean);
}

/**
 * @param {string} input  chemin vidéo source
 * @param {string} output chemin vidéo de sortie
 * @param {object} opts { format, watermark, watermarkPos, position, language, trimStart, trimEnd, fontSize }
 * @param {function} [transcribeFn] injection pour les tests (par défaut Groq)
 */
async function subtitle(input, output, opts = {}, transcribeFn = transcribe) {
  const trim = trimArgs(opts);
  let work = input;
  let workTmp = null;

  // 1) Découpe éventuelle dans un fichier de travail (timeline remise à zéro).
  if (trim.length) {
    workTmp = tmp("_work.mp4");
    await runFfmpeg([
      "-y", "-threads", "1", "-i", input, ...trim,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart", workTmp,
    ]);
    work = workTmp;
  }

  // 2) Extraction audio (16 kHz mono mp3, léger).
  const audio = tmp("_audio.mp3");
  await runFfmpeg([
    "-y", "-threads", "1", "-i", work,
    "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", audio,
  ]);

  // 3) Transcription.
  let segments = [];
  try {
    segments = await transcribeFn(audio, opts.language);
  } finally {
    try { fs.unlinkSync(audio); } catch {}
  }

  // 4) Incrustation : reformatage d'abord, puis sous-titres, puis filigrane.
  const vf = [
    formatFilter(opts.format),
    ...subtitleFilters(segments, opts),
    watermarkFilter(opts.watermark, opts.watermarkPos),
  ].filter(Boolean);
  const filter = vf.length ? vf.join(",") : "null";

  try {
    await runFfmpeg([
      "-y", "-threads", "1", "-i", work,
      "-vf", filter,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-c:a", "copy",
      "-movflags", "+faststart", output,
    ]);
  } finally {
    if (workTmp) { try { fs.unlinkSync(workTmp); } catch {} }
  }
  return { segments: segments.length };
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

module.exports = { subtitle, subtitleFilters, wrap, transcribe };
