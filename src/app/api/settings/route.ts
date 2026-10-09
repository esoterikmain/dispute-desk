import { z } from "zod";
import { handle } from "@/lib/http";
import { audit, saveSettings } from "@/lib/repo";

const Body = z.object({
  autopilot: z.boolean(),
  auto_refund_under: z.number().min(0).max(10000),
  auto_fight_above: z.number().min(50).max(100),
});

export const PUT = (req: Request) =>
  handle(async () => {
    const settings = Body.parse(await req.json());
    await saveSettings(settings);
    await audit(null, "merchant", "settings_changed", settings);
    return settings;
  });
