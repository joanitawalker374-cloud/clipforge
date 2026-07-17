// storage.js — dépôt des fichiers de sortie sur un stockage S3-compatible
// (Supabase Storage, Cloudflare R2, AWS S3... tous parlent le protocole S3).
const fs = require("fs");
const path = require("path");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const {
  S3_ENDPOINT,
  S3_REGION = "auto",
  S3_BUCKET,
  S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY,
} = process.env;

const s3 = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  forcePathStyle: true, // requis pour Supabase/R2/MinIO
  credentials: {
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
  },
});

const mimeByExt = { ".mp4": "video/mp4", ".mov": "video/quicktime" };

// Envoie un fichier local vers le bucket et renvoie sa clé.
async function uploadFile(localPath, key) {
  const Body = fs.createReadStream(localPath);
  const ContentType = mimeByExt[path.extname(localPath).toLowerCase()] || "application/octet-stream";
  await s3.send(
    new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body, ContentType })
  );
  return key;
}

// URL signée (téléchargement temporaire, par défaut 24 h).
async function signedGetUrl(key, expiresIn = 60 * 60 * 24) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }), {
    expiresIn,
  });
}

module.exports = { uploadFile, signedGetUrl };
