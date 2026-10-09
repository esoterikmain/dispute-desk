import { findOrder } from "@/lib/agent/casefile";
import { handle, type IdParams } from "@/lib/http";
import { evidencePdf } from "@/lib/pdf";
import { getDispute } from "@/lib/repo";

export const GET = (_req: Request, { params }: IdParams) =>
  handle(async () => {
    const { id } = await params;
    const dispute = await getDispute(id);
    if (!dispute) return Response.json({ error: "Not found" }, { status: 404 });
    const pdf = await evidencePdf(dispute, await findOrder(dispute), dispute.verdict?.response_letter ?? "");
    return new Response(pdf as BodyInit, {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="evidence-${id}.pdf"` },
    });
  });
