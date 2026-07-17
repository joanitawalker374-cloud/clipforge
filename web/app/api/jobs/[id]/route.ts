import { NextRequest, NextResponse } from "next/server";
import { getJob } from "@/lib/db";
import { signedGetUrl } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const job = await getJob(params.id);
  if (!job) return NextResponse.json({ error: "introuvable" }, { status: 404 });

  let downloadUrl: string | null = null;
  if (job.status === "done" && job.output_key) {
    downloadUrl = await signedGetUrl(job.output_key);
  }
  return NextResponse.json({
    id: job.id,
    type: job.type,
    status: job.status,
    error: job.error,
    downloadUrl,
  });
}
