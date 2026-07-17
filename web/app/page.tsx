"use client";

import { useState } from "react";

type Tool = "tiktok" | "caption" | "uniquify";
type Status = "idle" | "uploading" | "processing" | "done" | "error";

const TABS: { key: Tool; label: string; emoji: string; desc: string }[] = [
  { key: "tiktok", label: "TikTok HD", emoji: "⬇️", desc: "Colle un lien TikTok → vidéo HD sans watermark." },
  { key: "caption", label: "Légende", emoji: "✍️", desc: "Upload une vidéo + une légende → rendu propre." },
  { key: "uniquify", label: "Rendre unique", emoji: "🌀", desc: "Même vidéo, empreinte différente pour le repost." },
];

export default function Home() {
  const [tab, setTab] = useState<Tool>("tiktok");

  return (
    <main className="mx-auto max-w-2xl px-5 py-14">
      <header className="mb-10 text-center">
        <h1 className="text-4xl font-extrabold tracking-tight">
          Clip<span className="text-brand">Forge</span>
        </h1>
        <p className="mt-3 text-zinc-400">
          Télécharge, légende et rends tes vidéos uniques — prêtes à reposter.
        </p>
      </header>

      <div className="mb-6 grid grid-cols-3 gap-2 rounded-xl bg-white/5 p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
              tab === t.key ? "bg-brand text-white" : "text-zinc-300 hover:bg-white/5"
            }`}
          >
            <span className="mr-1">{t.emoji}</span>
            {t.label}
          </button>
        ))}
      </div>

      <p className="mb-4 text-center text-sm text-zinc-500">
        {TABS.find((t) => t.key === tab)!.desc}
      </p>

      <div className="rounded-2xl border border-white/10 bg-white/5 p-6 shadow-xl">
        {tab === "tiktok" ? <TikTokTool /> : <VideoTool tool={tab} key={tab} />}
      </div>

      <footer className="mt-10 text-center text-xs text-zinc-600">
        ClipForge · usage réservé à tes propres contenus et aux contenus dont tu as les droits.
      </footer>
    </main>
  );
}

function useJobRunner() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  async function poll(id: string) {
    setStatus("processing");
    for (let i = 0; i < 150; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const res = await fetch(`/api/jobs/${id}`);
      const j = await res.json();
      if (j.status === "done") {
        setDownloadUrl(j.downloadUrl);
        setStatus("done");
        return;
      }
      if (j.status === "error") {
        setError(j.error || "Le traitement a échoué.");
        setStatus("error");
        return;
      }
    }
    setError("Délai dépassé.");
    setStatus("error");
  }

  function reset() {
    setStatus("idle");
    setError(null);
    setDownloadUrl(null);
  }

  return { status, setStatus, error, setError, downloadUrl, poll, reset };
}

function TikTokTool() {
  const [url, setUrl] = useState("");
  const { status, setStatus, error, setError, downloadUrl, poll, reset } = useJobRunner();

  async function run() {
    reset();
    setStatus("processing");
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "tiktok", params: { url } }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error);
      await poll(j.id);
    } catch (e: any) {
      setError(e.message);
      setStatus("error");
    }
  }

  return (
    <div className="space-y-4">
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://www.tiktok.com/@…/video/…"
        className="w-full rounded-lg border border-white/10 bg-black/30 px-4 py-3 outline-none focus:border-brand"
      />
      <RunButton disabled={!url || status === "processing"} onClick={run} status={status} />
      <Result status={status} error={error} downloadUrl={downloadUrl} />
    </div>
  );
}

function VideoTool({ tool }: { tool: "caption" | "uniquify" }) {
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState("");
  const [position, setPosition] = useState("bottom");
  const { status, setStatus, error, setError, downloadUrl, poll, reset } = useJobRunner();

  async function run() {
    if (!file) return;
    reset();
    setStatus("uploading");
    try {
      const params =
        tool === "caption" ? { caption, position } : { level: "light" };
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: tool, params }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error);

      // upload direct du fichier source vers le stockage
      const put = await fetch(j.uploadUrl, {
        method: "PUT",
        headers: { "content-type": "video/mp4" },
        body: file,
      });
      if (!put.ok) throw new Error("Échec de l'upload");

      await fetch(`/api/jobs/${j.id}/start`, { method: "POST" });
      await poll(j.id);
    } catch (e: any) {
      setError(e.message);
      setStatus("error");
    }
  }

  return (
    <div className="space-y-4">
      <label className="block cursor-pointer rounded-lg border border-dashed border-white/20 bg-black/20 px-4 py-8 text-center hover:border-brand">
        <input
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
        />
        {file ? (
          <span className="text-sm text-zinc-200">{file.name}</span>
        ) : (
          <span className="text-sm text-zinc-500">Clique pour choisir une vidéo (mp4)</span>
        )}
      </label>

      {tool === "caption" && (
        <>
          <textarea
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="Ta légende…"
            rows={2}
            className="w-full rounded-lg border border-white/10 bg-black/30 px-4 py-3 outline-none focus:border-brand"
          />
          <div className="flex gap-2">
            {["top", "center", "bottom"].map((p) => (
              <button
                key={p}
                onClick={() => setPosition(p)}
                className={`flex-1 rounded-lg px-3 py-2 text-sm ${
                  position === p ? "bg-brand text-white" : "bg-white/5 text-zinc-300"
                }`}
              >
                {p === "top" ? "Haut" : p === "center" ? "Centre" : "Bas"}
              </button>
            ))}
          </div>
        </>
      )}

      <RunButton
        disabled={!file || status === "uploading" || status === "processing"}
        onClick={run}
        status={status}
      />
      <Result status={status} error={error} downloadUrl={downloadUrl} />
    </div>
  );
}

function RunButton({
  disabled,
  onClick,
  status,
}: {
  disabled: boolean;
  onClick: () => void;
  status: Status;
}) {
  const label =
    status === "uploading"
      ? "Envoi…"
      : status === "processing"
      ? "Traitement…"
      : "Lancer";
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="w-full rounded-lg bg-brand px-4 py-3 font-semibold text-white transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
    >
      {label}
    </button>
  );
}

function Result({
  status,
  error,
  downloadUrl,
}: {
  status: Status;
  error: string | null;
  downloadUrl: string | null;
}) {
  if (status === "error")
    return <p className="rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-300">⚠️ {error}</p>;
  if (status === "done" && downloadUrl)
    return (
      <a
        href={downloadUrl}
        className="block rounded-lg bg-emerald-500/15 px-4 py-3 text-center text-sm font-semibold text-emerald-300 hover:bg-emerald-500/25"
        download
      >
        ✅ Prêt — télécharger la vidéo
      </a>
    );
  if (status === "processing" || status === "uploading")
    return (
      <p className="text-center text-sm text-zinc-400">
        ⏳ Un instant, on prépare ta vidéo…
      </p>
    );
  return null;
}
