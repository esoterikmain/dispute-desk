import { handle } from "@/lib/http";
import { parseGridQuery } from "@/lib/nlfilter";

export const POST = (req: Request) =>
  handle(async () => {
    const { query } = (await req.json()) as { query?: string };
    if (!query?.trim()) throw new Error("Type what you want to see");
    return parseGridQuery(query.trim().slice(0, 300));
  });
