import { syncFromPayPal } from "@/lib/desk";
import { handle } from "@/lib/http";

export const POST = (req: Request) =>
  handle(async () => {
    const body = (await req.json().catch(() => ({}))) as { caseId?: string };
    const caseId = body.caseId?.trim();
    if (caseId && !/^[A-Za-z0-9-]{5,40}$/.test(caseId)) throw new Error("That does not look like a PayPal case ID");
    return syncFromPayPal(caseId || undefined);
  });
