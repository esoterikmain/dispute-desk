import { handle } from "@/lib/http";
import { sampleCasesEnabled } from "@/lib/paypal";
import { SCENARIOS } from "@/lib/scenarios";
import { simulateDispute } from "@/lib/seed";

export const GET = () => handle(async () => ({ scenarios: SCENARIOS.map((s) => ({ key: s.key, title: s.title })) }));

// Opens a sample case in the built-in simulator. Available next to real PayPal unless DEMO_DATA=off.
export const POST = (req: Request) =>
  handle(async () => {
    if (!sampleCasesEnabled()) throw new Error("Sample cases are switched off (DEMO_DATA=off)");
    const body = (await req.json().catch(() => ({}))) as { scenario?: string };
    return { id: await simulateDispute(body.scenario) };
  });
