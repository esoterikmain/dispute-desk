import { handle } from "@/lib/http";
import { isLivePayPal } from "@/lib/paypal";
import { SCENARIOS } from "@/lib/scenarios";
import { simulateDispute } from "@/lib/seed";

export const GET = () => handle(async () => ({ scenarios: SCENARIOS.map((s) => ({ key: s.key, title: s.title })) }));

export const POST = (req: Request) =>
  handle(async () => {
    if (isLivePayPal()) {
      throw new Error("Connected to the PayPal sandbox: open a dispute as the sandbox buyer, then press Sync.");
    }
    const body = (await req.json().catch(() => ({}))) as { scenario?: string };
    return { id: await simulateDispute(body.scenario) };
  });
