import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ClipForge — TikTok HD, légendes & repost unique",
  description:
    "Télécharge des TikTok en HD, ajoute une légende propre, et rends chaque vidéo unique pour le repost.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="fr">
      <body className="text-zinc-100 antialiased">{children}</body>
    </html>
  );
}
