import { z } from "zod";
import { handle } from "@/lib/http";
import { captureCheckout } from "@/lib/store";

const Body = z.object({
  paypalOrderId: z.string(),
  fulfilment: z.enum(["delivered_signed", "delivered", "in_transit", "untracked"]),
});

export const POST = (req: Request) =>
  handle(async () => {
    const body = Body.parse(await req.json());
    return captureCheckout(body.paypalOrderId, body.fulfilment);
  });
