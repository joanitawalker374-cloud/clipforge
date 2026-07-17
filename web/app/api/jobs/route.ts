import { NextRequest, NextResponse } from "next/server";
import { createJob, pool, JobType } from "@/lib/db";
import { signedPutUrl } from "@/lib/storage";
import { triggerWorker } from "@/lib/worker";

export const runtime = "nodejs";

const NEEDS_UPLOAD: JobType[] = ["caption", "uniquify"];

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const type = body.type as JobType;
    const params = (body.params || {}) as Record<string, unknown>;

    if (!["tiktok", "caption", "uniquify"].includes(type)) {
      return NextResponse.json({ error: "type invalide" }, { status: 400 });
    }

    if (type === "tiktok") {
      if (!params.url || typeof params.url !== "string") {
        return NextResponse.json({ error: "url requise" }, { status: 400 });
      }
      const id = await createJob(type, params);
      await triggerWorker(id);
      return NextResponse.json({ id });
    }

    // caption / uniquify : on crée le job, puis on renvoie une URL d'upload directe.
    const id = await createJob(type, params);
    const inputKey = `inputs/${id}.mp4`;
    await pool.query("UPDATE jobs SET input_key=$1 WHERE id=$2", [inputKey, id]);
    const uploadUrl = await signedPutUrl(inputKey, "video/mp4");
    return NextResponse.json({ id, uploadUrl });
  } catch (e: any) {
    console.error(e);
    return NextResponse.json({ error: e.message || "erreur" }, { status: 500 });
  }
}
