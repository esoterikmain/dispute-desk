import { queueAnalysis } from "@/lib/desk";
import { handle, type IdParams } from "@/lib/http";
import { getDispute, updateDispute } from "@/lib/repo";

export const POST = (_req: Request, { params }: IdParams) =>
  handle(async () => {
    const { id } = await params;
    const dispute = await getDispute(id);
    if (!dispute) return Response.json({ error: "Not found" }, { status: 404 });
    if (dispute.decision || dispute.outcome) throw new Error("This dispute has already been actioned");
    await updateDispute(id, { agent_status: "queued", agent_step: null });
    queueAnalysis(id);
    return { ok: true };
  });
