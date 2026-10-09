import { findOrder } from "@/lib/agent/casefile";
import { handle, type IdParams } from "@/lib/http";
import { getDispute, listAudit } from "@/lib/repo";

export const GET = (_req: Request, { params }: IdParams) =>
  handle(async () => {
    const { id } = await params;
    const dispute = await getDispute(id);
    if (!dispute) return Response.json({ error: "Not found" }, { status: 404 });
    return { dispute, order: await findOrder(dispute), audit: await listAudit(id) };
  });
