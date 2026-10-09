// Shapes shared by the server, the agent and the grid.

export type Money = { currency_code: string; value: string };

/** Subset of PayPal's Customer Disputes v1 dispute object that we rely on. */
export interface PayPalDispute {
  dispute_id: string;
  create_time: string;
  update_time: string;
  reason: string;
  status: string;
  dispute_amount: Money;
  dispute_life_cycle_stage?: string;
  seller_response_due_date?: string;
  dispute_outcome?: { outcome_code: string; amount_refunded?: Money };
  disputed_transactions?: Array<{
    seller_transaction_id?: string;
    buyer_transaction_id?: string;
    buyer?: { name?: string; email?: string };
    custom?: string;
    invoice_number?: string;
  }>;
  messages?: Array<{ posted_by: string; time_posted: string; content: string }>;
  offer?: { seller_offered_amount?: Money };
  evidences?: unknown[];
  /** HATEOAS links: the actions PayPal currently allows on this dispute. */
  links?: Array<{ rel: string; href?: string }>;
}

export interface TrackingEvent {
  at: string;
  status: string;
  location?: string;
}

/** A merchant-side order record: the evidence the agent works from. */
export interface StoreOrder {
  id: string;
  paypal_order_id?: string;
  capture_id: string;
  buyer_name: string;
  buyer_email: string;
  placed_at: string;
  amount: number;
  currency: string;
  items: Array<{ name: string; qty: number; price: number; description?: string }>;
  shipping_address: string;
  /** Whether the shipping address matches the address on the buyer's PayPal account. */
  address_matches_account?: boolean;
  shipment?: {
    carrier: string;
    tracking_number: string;
    shipped_at: string;
    delivered_at?: string;
    signed_by?: string;
    events: TrackingEvent[];
  } | null;
  risk?: {
    account_age_days?: number;
    prior_orders?: number;
    avs_match?: boolean;
    ip_country?: string;
  };
  refunds?: Array<{ id: string; amount: number; at: string }>;
  return_received_at?: string;
  /** Customer-service thread between buyer and merchant. */
  messages?: Array<{ from: "buyer" | "merchant"; at: string; body: string }>;
  internal_notes?: string;
}

export type Recommendation = "FIGHT" | "REFUND" | "OFFER";
export type AgentStatus = "idle" | "queued" | "running" | "done" | "error";
export type Outcome = "WON" | "LOST" | "REFUNDED" | "SETTLED";
export type Engine = "claude" | "rules";

export interface EvidenceItem {
  label: string;
  detail: string;
  strength: "strong" | "moderate" | "weak";
}

/** What the agent decides for one dispute. */
export interface Verdict {
  win_probability: number;
  recommendation: Recommendation;
  offer_amount: number | null;
  summary: string;
  reasoning: string;
  evidence: EvidenceItem[];
  missing_evidence: string[];
  risk_flags: string[];
  response_letter: string;
}

export interface DisputeRow {
  id: string;
  /** Where the case lives: the real PayPal API, or the built-in simulator (sample cases). */
  source: "paypal" | "simulator";
  status: string;
  reason: string;
  stage: string | null;
  amount: number;
  currency: string;
  buyer_name: string | null;
  buyer_email: string | null;
  transaction_id: string | null;
  order_id: string | null;
  created_at: string;
  updated_at: string;
  response_due: string | null;
  outcome: Outcome | null;
  resolved_at: string | null;
  agent_status: AgentStatus;
  agent_step: string | null;
  engine: Engine | null;
  verdict: Verdict | null;
  evidence_score: number | null;
  decision: Recommendation | null;
  decided_by: string | null;
  submitted_at: string | null;
  raw: PayPalDispute;
}

export interface AuditEntry {
  id: number;
  dispute_id: string | null;
  actor: "agent" | "merchant" | "autopilot" | "paypal" | "system";
  action: string;
  detail: Record<string, unknown> | null;
  at: string;
}

export interface Settings {
  autopilot: boolean;
  /** Auto-refund when the disputed amount is below this and the agent recommends REFUND. */
  auto_refund_under: number;
  /** Auto-submit evidence when the win probability is at or above this. */
  auto_fight_above: number;
}

export const DEFAULT_SETTINGS: Settings = {
  autopilot: false,
  auto_refund_under: 15,
  auto_fight_above: 85,
};

export const REASON_LABELS: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Item not received",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Not as described",
  UNAUTHORISED: "Unauthorized",
  DUPLICATE_TRANSACTION: "Duplicate charge",
  CREDIT_NOT_PROCESSED: "Refund not received",
  INCORRECT_AMOUNT: "Incorrect amount",
  CANCELED_RECURRING_BILLING: "Cancelled subscription",
  PAYMENT_BY_OTHER_MEANS: "Paid another way",
  PROBLEM_WITH_REMITTANCE: "Remittance problem",
  OTHER: "Other",
};

export const STATUS_LABELS: Record<string, string> = {
  OPEN: "Open",
  WAITING_FOR_SELLER_RESPONSE: "Needs response",
  WAITING_FOR_BUYER_RESPONSE: "Waiting on buyer",
  UNDER_REVIEW: "Under PayPal review",
  RESOLVED: "Resolved",
  OTHER: "Other",
};
