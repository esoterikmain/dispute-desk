import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { MODEL, anthropic, hasClaude } from "./agent/claude";
import { REASON_LABELS, STATUS_LABELS } from "./types";
import { takeAllowance } from "./usage";

// "unauthorized claims over $100 due this week" -> filters the grid can apply.

export const FILTER_FIELDS = [
  "reason",
  "status",
  "buyer_name",
  "recommendation",
  "outcome",
  "amount",
  "win_probability",
  "evidence_score",
  "due_in_hours",
] as const;

const GridQuery = z.object({
  filters: z.array(
    z.object({
      field: z.enum(FILTER_FIELDS),
      op: z.enum(["contains", "equals", "greaterThan", "lessThan"]),
      value: z.string(),
    }),
  ),
  sort: z.object({ field: z.enum(FILTER_FIELDS), direction: z.enum(["asc", "desc"]) }).nullable(),
  explanation: z.string(),
});
export type GridQuery = z.infer<typeof GridQuery>;

const SYSTEM = `You translate a merchant's plain-English request into filters for a table of PayPal disputes.

Columns:
- reason (text). Values: ${Object.values(REASON_LABELS).join(", ")}.
- status (text). Values: ${Object.values(STATUS_LABELS).join(", ")}.
- buyer_name (text).
- recommendation (text). Values: Fight, Refund, Offer.
- outcome (text). Values: Won, Lost, Refunded, Settled. Empty while a dispute is open.
- amount (number, in dollars).
- win_probability (number, 0-100).
- evidence_score (number, 0-100).
- due_in_hours (number): hours until the seller's response deadline. "Due today" is under 24, "this week" is under 168. Negative means overdue.

Use "contains" or "equals" for text columns and "greaterThan" or "lessThan" for number columns. Write text values exactly as listed above and number values as plain digits. Add a sort only when the request implies an order. In "explanation", restate in one short sentence what the table now shows. If the request cannot be expressed with these columns, return no filters and say so in the explanation.`;

export async function parseGridQuery(text: string): Promise<GridQuery & { engine: "claude" | "rules" }> {
  if (hasClaude() && (await takeAllowance("filter"))) {
    try {
      const response = await anthropic().beta.messages.parse({
        model: MODEL,
        max_tokens: 2000,
        system: SYSTEM,
        output_config: { effort: "low", format: zodOutputFormat(GridQuery) },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        messages: [{ role: "user", content: text }],
      });
      if (response.stop_reason !== "refusal" && response.parsed_output) {
        return { ...response.parsed_output, engine: "claude" };
      }
    } catch (err) {
      console.error("[nlfilter] Claude parse failed, using keyword parser", err);
    }
  }
  return { ...keywordQuery(text), engine: "rules" };
}

const OP_WORDS = { contains: "contains", equals: "is", greaterThan: "over", lessThan: "under" } as const;

/** Keyword fallback for running without Claude credentials. Handles the common phrasings only. */
export function keywordQuery(text: string): GridQuery {
  const t = text.toLowerCase();
  const filters: GridQuery["filters"] = [];
  const add = (field: GridQuery["filters"][number]["field"], op: GridQuery["filters"][number]["op"], value: string) =>
    filters.push({ field, op, value });

  const reasons: Array<[RegExp, string]> = [
    [/not received|never (arrived|received)|missing/, "Item not received"],
    [/not as described|wrong item|damaged|defect/, "Not as described"],
    [/unauthori[sz]ed|fraud/, "Unauthorized"],
    [/duplicate|charged twice|double/, "Duplicate charge"],
    [/refund not|credit not/, "Refund not received"],
  ];
  for (const [pattern, label] of reasons) if (pattern.test(t)) add("reason", "equals", label);

  const pct = t.match(/(win|chance|probability)[^0-9]*(over|above|under|below|>|<)\s*(\d+)/);
  if (pct) add("win_probability", /over|above|>/.test(pct[2]) ? "greaterThan" : "lessThan", pct[3]);

  const over = t.match(/(?:over|above|more than|>)\s*\$\s*(\d+(?:\.\d+)?)/);
  if (over) add("amount", "greaterThan", over[1]);
  const under = t.match(/(?:under|below|less than|<)\s*\$\s*(\d+(?:\.\d+)?)/);
  if (under) add("amount", "lessThan", under[1]);

  if (/overdue/.test(t)) add("due_in_hours", "lessThan", "0");
  else if (/due today/.test(t)) add("due_in_hours", "lessThan", "24");
  else if (/due tomorrow/.test(t)) add("due_in_hours", "lessThan", "48");
  else if (/(due )?this week/.test(t)) add("due_in_hours", "lessThan", "168");
  const days = t.match(/due (?:in|within) (\d+) days?/);
  if (days) add("due_in_hours", "lessThan", String(Number(days[1]) * 24));

  if (/\bfight\b|contest|winnable/.test(t)) add("recommendation", "equals", "Fight");
  else if (/\boffer\b|partial/.test(t)) add("recommendation", "equals", "Offer");
  else if (/\brefund\b/.test(t) && !/refund not/.test(t)) add("recommendation", "equals", "Refund");

  if (/\bwon\b/.test(t)) add("outcome", "equals", "Won");
  else if (/\blost\b/.test(t)) add("outcome", "equals", "Lost");
  if (/needs? (a )?response|to do|action/.test(t)) add("status", "equals", "Needs response");

  const sort = /biggest|largest|highest amount/.test(t)
    ? ({ field: "amount", direction: "desc" } as const)
    : /urgent|soonest|deadline/.test(t)
      ? ({ field: "due_in_hours", direction: "asc" } as const)
      : null;

  return {
    filters,
    sort,
    explanation: filters.length
      ? `Showing ${filters.map((f) => `${f.field.replaceAll("_", " ")} ${OP_WORDS[f.op]} ${f.value}`).join(", ")} (keyword match).`
      : "No filters recognised. Add an Anthropic API key for full natural-language search.",
  };
}
