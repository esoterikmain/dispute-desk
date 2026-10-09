import { getDb } from "./db";

// A daily ceiling on paid model calls, so a public demo cannot drain the API credits.
// Counts live in the database and reset at midnight UTC.

export type UsageKind = "analysis" | "filter";

const DEFAULTS: Record<UsageKind, number> = { analysis: 100, filter: 300 };
const ENV: Record<UsageKind, string> = { analysis: "AI_DAILY_ANALYSES", filter: "AI_DAILY_FILTERS" };

/** The configured ceiling for one kind of call. Zero or less means unlimited. */
export function dailyLimit(kind: UsageKind): number {
  const raw = process.env[ENV[kind]];
  const parsed = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULTS[kind];
}

const today = () => new Date().toISOString().slice(0, 10);

/** Claim one call from today's allowance. Returns false when the allowance is used up. */
export async function takeAllowance(kind: UsageKind): Promise<boolean> {
  const limit = dailyLimit(kind);
  if (limit <= 0) return true;
  const db = await getDb();
  // One statement, so two requests racing for the last slot cannot both win.
  const rows = await db.query(
    `INSERT INTO ai_usage (day, kind, count) VALUES ($1, $2, 1)
     ON CONFLICT (day, kind) DO UPDATE SET count = ai_usage.count + 1 WHERE ai_usage.count < $3
     RETURNING count`,
    [today(), kind, limit],
  );
  return rows.length > 0;
}

export async function usageToday(kind: UsageKind): Promise<{ used: number; limit: number }> {
  const db = await getDb();
  const rows = await db.query<{ count: number }>("SELECT count FROM ai_usage WHERE day = $1 AND kind = $2", [today(), kind]);
  return { used: rows[0]?.count ?? 0, limit: dailyLimit(kind) };
}
