import { z } from "zod";
import { handle } from "@/lib/http";
import { isLivePayPal } from "@/lib/paypal";
import { simulateDisputeForOrder } from "@/lib/seed";

const Body = z.object({ orderId: z.string(), reason: z.string() });

// Simulator only. Against the real sandbox the buyer opens the dispute at sandbox.paypal.com:
// PayPal's dispute-creation API call needs the buyer's identity, which a merchant app cannot assert.
export const POST = (req: Request) =>
  handle(async () => {
    if (isLivePayPal()) throw new Error("Open the dispute as the sandbox buyer in PayPal's Resolution Center.");
    const { orderId, reason } = Body.parse(await req.json());
    return { id: await simulateDisputeForOrder(orderId, reason) };
  });
