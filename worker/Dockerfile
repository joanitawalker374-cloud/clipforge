# Worker vidéo : Node + ffmpeg + yt-dlp
FROM node:20-slim

# ffmpeg + python (pour yt-dlp) + certs
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 python3-pip ca-certificates fonts-dejavu-core curl \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp (binaire officiel, mis à jour facilement)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=8080
EXPOSE 8080
CMD ["node", "index.js"]
