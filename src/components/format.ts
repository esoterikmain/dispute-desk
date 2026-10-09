import { REASON_LABELS, STATUS_LABELS, type DisputeRow, type Outcome, type Recommendation } from "@/lib/types";

export type DeskDispute = Omit<DisputeRow, "raw">;

export interface DeskMode {
  paypal: "live" | "simulator";
  ai: "claude" | "rules";
  model: string | null;
  /** Whether the built-in sample cases (simulator) are available. */
  sample_cases: boolean;
  webhook_verified: boolean;
  /** AI analyses used today against the daily ceiling. A limit of zero means unlimited. */
  ai_usage: { used: number; limit: number };
}

export const REC_LABEL: Record<Recommendation, string> = { FIGHT: "Fight", REFUND: "Refund", OFFER: "Offer" };
export const OUTCOME_LABEL: Record<Outcome, string> = { WON: "Won", LOST: "Lost", REFUNDED: "Refunded", SETTLED: "Settled" };
export const DECISION_STATUS: Record<Recommendation, string> = {
  FIGHT: "Evidence submitted",
  REFUND: "Refund sent",
  OFFER: "Offer sent",
};

export const money = (n: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: n % 1 === 0 ? 0 : 2 }).format(n);

export const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function dueLabel(hours: number): string {
  const abs = Math.abs(hours);
  const text = abs >= 48 ? `${Math.floor(abs / 24)} days` : abs >= 24 ? `1 day ${Math.floor(abs - 24)}h` : `${Math.max(1, Math.floor(abs))}h`;
  return hours < 0 ? `Overdue ${text}` : text;
}

/** A dispute as the grid shows it: display values precomputed so filters match what is on screen. */
export interface GridRow extends DeskDispute {
  reason_label: string;
  status_label: string;
  due_in_hours: number | null;
  win_probability: number | null;
  recommendation_label: string | null;
  outcome_label: string | null;
  summary: string;
  actionable: boolean;
}

export function toGridRow(d: DeskDispute, now: number): GridRow {
  const open = !d.outcome && !d.decision;
  return {
    ...d,
    reason_label: REASON_LABELS[d.reason] ?? d.reason,
    status_label: d.outcome ? "Resolved" : d.decision ? DECISION_STATUS[d.decision] : (STATUS_LABELS[d.status] ?? d.status),
    due_in_hours: open && d.response_due ? Math.round(((Date.parse(d.response_due) - now) / 3_600_000) * 10) / 10 : null,
    win_probability: d.verdict?.win_probability ?? null,
    recommendation_label: d.verdict ? REC_LABEL[d.verdict.recommendation] : null,
    outcome_label: d.outcome ? OUTCOME_LABEL[d.outcome] : null,
    summary: d.verdict?.summary ?? "",
    actionable: open && d.agent_status === "done" && !!d.verdict,
  };
}

/** Money kept by the merchant on a resolved dispute. */
export function recovered(d: DeskDispute): number {
  if (d.outcome === "WON") return d.amount;
  if (d.outcome === "SETTLED") return d.amount - (d.verdict?.offer_amount ?? 0);
  return 0;
}

export async function api<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? (init?.body ? "POST" : "GET"),
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `Request failed (${res.status})`);
  return json as T;
}
