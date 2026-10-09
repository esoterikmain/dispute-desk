import { MODEL, hasClaude } from "@/lib/agent/claude";
import { deskSnapshot } from "@/lib/desk";
import { handle } from "@/lib/http";
import { isLivePayPal } from "@/lib/paypal";
import { getSettings } from "@/lib/repo";
import { ensureSeeded } from "@/lib/seed";
import { usageToday } from "@/lib/usage";

export const GET = () =>
  handle(async () => {
    await ensureSeeded();
    const rows = await deskSnapshot();
    return {
      // The raw PayPal document is only needed in the detail view.
      disputes: rows.map((row) => ({ ...row, raw: undefined })),
      settings: await getSettings(),
      mode: {
        paypal: isLivePayPal() ? "live" : "simulator",
        ai: hasClaude() ? "claude" : "rules",
        model: hasClaude() ? MODEL : null,
        webhook_verified: !!process.env.PAYPAL_WEBHOOK_ID,
        ai_usage: await usageToday("analysis"),
      },
    };
  });
