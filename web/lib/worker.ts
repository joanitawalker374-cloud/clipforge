// Déclenche le worker (fire-and-forget). Le worker met la base à jour lui-même.
export async function triggerWorker(jobId: string) {
  const url = process.env.WORKER_URL;
  if (!url) throw new Error("WORKER_URL manquant");
  const res = await fetch(url.replace(/\/$/, "") + "/process", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-worker-secret": process.env.WORKER_SECRET || "",
    },
    body: JSON.stringify({ jobId }),
  });
  if (!res.ok) throw new Error("worker a répondu " + res.status);
}
