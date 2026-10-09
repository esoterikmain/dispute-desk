import { handle } from "@/lib/http";
import { resetDemo } from "@/lib/seed";

export const POST = () =>
  handle(async () => {
    await resetDemo();
    return { ok: true };
  });
