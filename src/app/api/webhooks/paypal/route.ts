import { ingestDispute } from "@/lib/desk";
import { handle } from "@/lib/http";
import { isLivePayPal, paypal } from "@/lib/paypal";

// PayPal calls this for CUSTOMER.DISPUTE.CREATED / UPDATED / RESOLVED.
export const POST = (req: Request) =>
  handle(async () => {
    if (!isLivePayPal()) return Response.json({ error: "PayPal is not configured" }, { status: 503 });
    const event = (await req.json()) as { event_type?: string; resource?: { dispute_id?: string } };

    if (process.env.PAYPAL_WEBHOOK_ID && !(await paypal().verifyWebhook(req.headers, event))) {
      return Response.json({ error: "Signature verification failed" }, { status: 400 });
    }
    const disputeId = event.resource?.dispute_id;
    if (!event.event_type?.startsWith("CUSTOMER.DISPUTE.") || !disputeId) return { ignored: true };

    // The body only tells us which dispute changed. The dispute itself is re-read from
    // PayPal with our own credentials, so a forged event cannot plant data.
    const result = await ingestDispute(await paypal().getDispute(disputeId), `webhook:${event.event_type}`, "paypal");
    return { ok: true, ...result };
  });
