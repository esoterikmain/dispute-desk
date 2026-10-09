import { z } from "zod";
import { handle } from "@/lib/http";
import { getOrder } from "@/lib/repo";
import { isSampleOrder, simulateDisputeForOrder } from "@/lib/seed";

const Body = z.object({ orderId: z.string(), reason: z.string() });

// Simulated orders only. On a real sandbox payment the buyer opens the dispute at sandbox.paypal.com:
// PayPal's dispute-creation API call needs the buyer's identity, which a merchant app cannot assert.
export const POST = (req: Request) =>
  handle(async () => {
    const { orderId, reason } = Body.parse(await req.json());
    const order = await getOrder(orderId);
    if (!order?.capture_id) throw new Error("Order not found or not paid");
    if (!isSampleOrder(order.capture_id)) {
      throw new Error("This is a real sandbox payment: open the dispute as the buyer in PayPal's Resolution Center.");
    }
    return { id: await simulateDisputeForOrder(orderId, reason) };
  });
