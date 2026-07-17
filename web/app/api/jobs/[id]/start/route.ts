import { NextRequest, NextResponse } from "next/server";
import { triggerWorker } from "@/lib/worker";

export const runtime = "nodejs";

// Appelé par le client une fois l'upload du fichier source terminé.
export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await triggerWorker(params.id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || "erreur" }, { status: 500 });
  }
}
