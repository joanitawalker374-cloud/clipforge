// uniquify.js — produit une variante "différente" d'une même vidéo pour passer
// la détection de doublon : ré-encodage + nouvelles métadonnées + micro-transformations
// visuelles imperceptibles (léger zoom/crop, bruit très faible, pixel de bordure,
// variation de saturation/contraste, léger changement de vitesse audio/vidéo).
// Le but est un fichier avec une empreinte (hash + fingerprint visuel) différente,
// sans dégrader la qualité perçue.
const { spawn } = require("child_process");
const { formatFilter, watermarkFilter, trimArgs } = require("./media");

// PRNG déterministe simple (mulberry32) pour des variations reproductibles par "seed".
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(r, min, max) {
  return min + r() * (max - min);
}

/**
 * @param {string} input
 * @param {string} output
 * @param {object} opts { seed, level: 'meta'|'light' }
 */
function uniquify(input, output, opts = {}) {
  const seed = (opts.seed ?? Math.floor(Date.now() % 1e9)) | 0;
  const level = opts.level || "light";
  const r = rng(seed);

  // Métadonnées "crédibles" et variées.
  const now = new Date();
  const iso = now.toISOString().replace(/\.\d+Z$/, "Z");
  const devices = ["iPhone 14", "iPhone 15 Pro", "Pixel 8", "Galaxy S23", "iPhone 13"];
  const device = devices[Math.floor(r() * devices.length)];
  const meta = [
    "-map_metadata", "-1", // on efface d'abord toutes les métadonnées d'origine
    "-metadata", `creation_time=${iso}`,
    "-metadata", `com.apple.quicktime.make=${device.includes("iPhone") ? "Apple" : "Android"}`,
    "-metadata", `com.apple.quicktime.model=${device}`,
    "-metadata", `encoder=clipforge`,
    "-metadata", `title=`,
    "-metadata", `comment=`,
  ];

  const trim = trimArgs(opts);
  const args = ["-y", "-threads", "1", "-i", input, ...trim];

  if (level === "meta") {
    // Juste ré-écriture des métadonnées + remux. Si découpe, on ré-encode (copy + trim = risque de désync).
    if (trim.length) {
      args.push(
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        ...meta, "-movflags", "+faststart", output
      );
    } else {
      args.push("-c", "copy", ...meta, "-movflags", "+faststart", output);
    }
    return runFfmpeg(args);
  }

  // level === 'light' : transformations visuelles imperceptibles + ré-encodage.
  const zoom = pick(r, 1.012, 1.028); // léger crop/zoom (1.2%–2.8%)
  const sat = pick(r, 0.97, 1.03); // saturation
  const contrast = pick(r, 0.98, 1.02);
  const bright = pick(r, -0.015, 0.015);
  const hue = pick(r, -3, 3); // très légère rotation de teinte (degrés)
  const noise = Math.floor(pick(r, 3, 8)); // bruit faible
  const speed = pick(r, 0.99, 1.01); // ±1% vitesse
  const atempo = speed; // même facteur côté audio

  // Chaîne de filtres vidéo. Ordre : reformatage éventuel d'abord, puis les
  // micro-transformations d'unicité, puis le filigrane par-dessus.
  const vf = [
    formatFilter(opts.format),
    // miroir horizontal optionnel : casse fortement l'empreinte visuelle (anti-doublon).
    opts.flip ? "hflip" : null,
    // léger zoom + recadrage centré à la taille d'origine (change l'empreinte visuelle)
    `scale=iw*${zoom.toFixed(4)}:ih*${zoom.toFixed(4)}`,
    `crop=iw/${zoom.toFixed(4)}:ih/${zoom.toFixed(4)}`,
    `eq=contrast=${contrast.toFixed(4)}:brightness=${bright.toFixed(4)}:saturation=${sat.toFixed(4)}`,
    `hue=h=${hue.toFixed(2)}`,
    `noise=alls=${noise}:allf=t`,
    `setpts=${(1 / speed).toFixed(5)}*PTS`,
    watermarkFilter(opts.watermark, opts.watermarkPos),
  ]
    .filter(Boolean)
    .join(",");

  args.push(
    "-vf", vf,
    "-af", `atempo=${atempo.toFixed(5)}`,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-c:a", "aac",
    "-b:a", "128k",
    ...meta,
    "-movflags", "+faststart",
    output
  );
  return runFfmpeg(args).then(() => ({ seed, device, zoom, sat, contrast, speed }));
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

module.exports = { uniquify };
