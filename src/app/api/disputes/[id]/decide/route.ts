import { z } from "zod";
import { act } from "@/lib/desk";
import { handle, type IdParams } from "@/lib/http";

const Body = z.object({
  action: z.enum(["FIGHT", "REFUND", "OFFER"]),
  letter: z.string().max(4000).optional(),
  offerAmount: z.number().positive().optional(),
});

export const POST = (req: Request, { params }: IdParams) =>
  handle(async () => {
    const { id } = await params;
    const body = Body.parse(await req.json());
    await act(id, { ...body, actor: "merchant" });
    return { ok: true };
  });
