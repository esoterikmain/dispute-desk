import { z } from "zod";
import { forceOutcome } from "@/lib/desk";
import { handle, type IdParams } from "@/lib/http";

const Body = z.object({ outcome: z.enum(["SELLER_FAVOR", "BUYER_FAVOR"]) });

// Sandbox test control: PayPal's adjudicate endpoint only exists in the sandbox.
export const POST = (req: Request, { params }: IdParams) =>
  handle(async () => {
    const { id } = await params;
    await forceOutcome(id, Body.parse(await req.json()).outcome);
    return { ok: true };
  });
