# ClipForge

SaaS de repost vidéo. Trois outils :

1. **TikTok HD** — colle un lien TikTok, récupère la vidéo en HD (sans watermark).
2. **Légende** — upload une vidéo + une légende, obtiens un rendu propre (style Reel).
3. **Rendre unique** — reprend la même vidéo et change son empreinte (métadonnées + micro-transformations) pour passer la détection de doublon au repost.

## Architecture

```
Navigateur ─▶ Site Next.js (Vercel) ─▶ Base Postgres (Supabase)
                    │                         ▲
                    │ upload direct           │ mise à jour statut
                    ▼                         │
             Stockage S3 (Supabase) ◀── Worker vidéo (Render)
                                          ffmpeg + yt-dlp
```

- **web/** : le site + l'API (Vercel). Ne fait PAS de traitement lourd.
- **worker/** : le service qui télécharge/édite les vidéos (Render, en Docker).
- **supabase/** : le schéma de base de données.

Vercel ne peut pas faire tourner ffmpeg sur des vidéos longues → tout le traitement
vit dans le worker. Le site ne fait qu'orchestrer.

---

## Déploiement — pas à pas

### 1) Supabase (base de données + stockage) — gratuit

1. Crée un compte sur https://supabase.com puis un nouveau projet.
2. **SQL Editor** → colle le contenu de `supabase/schema.sql` → **Run**.
3. **Storage** → *New bucket* → nom `clipforge`, **Private**.
4. **Project Settings → Database** → copie la *Connection string* (URI) → ce sera `DATABASE_URL`.
5. **Storage → Settings → S3 connection** → active-le, note :
   - `S3_ENDPOINT` (ex. `https://xxxx.supabase.co/storage/v1/s3`)
   - `S3_ACCESS_KEY_ID` et `S3_SECRET_ACCESS_KEY` (génère une clé)
   - `S3_BUCKET=clipforge`, `S3_REGION=auto`

### 2) Worker (Render) — le moteur vidéo

1. Mets le dossier `worker/` sur un dépôt GitHub (ou le repo entier).
2. Sur https://render.com → *New* → **Web Service** → connecte le repo.
3. Réglages :
   - **Root Directory** : `worker`
   - **Environment** : `Docker` (le `Dockerfile` est fourni)
   - **Instance** : Starter (le plan gratuit s'endort ; Starter reste réveillé).
4. **Environment** → ajoute les variables de `worker/.env.example`
   (`DATABASE_URL`, `S3_*`, `WORKER_SECRET`). Choisis un `WORKER_SECRET` long et garde-le.
5. Déploie. Note l'URL publique (ex. `https://clipforge-worker.onrender.com`).
   Vérifie `https://…/health` → doit répondre `{"ok":true}`.

### 3) Site (Vercel)

1. Mets le dossier `web/` sur GitHub.
2. Sur https://vercel.com → *New Project* → importe le repo.
   - **Root Directory** : `web`
3. **Environment Variables** → ajoute celles de `web/.env.example` :
   - `DATABASE_URL`, `PGSSL=require`
   - `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
   - `WORKER_URL` = l'URL Render de l'étape 2
   - `WORKER_SECRET` = **le même** que le worker
4. Déploie. Ouvre l'URL Vercel → teste les 3 onglets.

### 4) CORS du stockage (pour l'upload direct navigateur)

Dans Supabase → Storage → *Policies/CORS*, autorise l'origine de ton site Vercel
(`https://ton-site.vercel.app`) en méthode `PUT` et `GET`. Sinon l'upload navigateur
sera bloqué.

---

## Lancer en local

```bash
# worker
cd worker && cp .env.example .env   # remplis les valeurs
npm install && npm start            # ffmpeg + yt-dlp requis sur la machine

# site
cd web && cp .env.example .env.local
npm install && npm run dev          # http://localhost:3000
```

---

## Réglages utiles

- **Police des légendes** : `worker/assets/font.ttf`. Remplace-la par ta police
  (ex. une police avec emojis type *Noto* si tu veux garder les emojis ; par défaut
  ils sont retirés pour éviter les carrés blancs).
- **Niveau d'unicité** : dans `worker/lib/uniquify.js` — `light` (transformations
  visuelles + métadonnées) ou `meta` (métadonnées seules, plus rapide).
- **Qualité TikTok** : `worker/lib/tiktok.js` (`-f bv*+ba/b` = meilleure dispo).

## Étapes suivantes (quand tu voudras passer en vrai SaaS)

- Comptes utilisateurs (Supabase Auth est déjà là).
- Abonnement Stripe + quotas par utilisateur.
- File d'attente (BullMQ/Redis) si beaucoup de vidéos en parallèle.
- Historique des rendus par utilisateur (table `jobs` déjà prête).

## Note d'usage

Outil destiné à tes propres contenus ou à des contenus dont tu détiens les droits.
Le téléchargement et la republication de contenus tiers peuvent enfreindre les
conditions d'utilisation des plateformes et le droit d'auteur — à toi de t'assurer
d'être en règle.
