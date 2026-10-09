import { randomBytes } from "node:crypto";
import { evidenceScore, gatherCase } from "./agent/casefile";
import { getDb } from "./db";
import { rulesVerdict } from "./agent/rules";
import { ingestDispute, toRow } from "./desk";
import { isLivePayPal } from "./paypal";
import { simPutDispute } from "./paypal/simulator";
import { audit, getOrder, insertDispute, listDisputes, saveOrder, updateDispute, wipeAll } from "./repo";
import { SCENARIOS, SCENARIO_BY_KEY, buildCase, type Scenario } from "./scenarios";
import type { Outcome, PayPalDispute, Recommendation } from "./types";

const suffix = () => randomBytes(4).toString("hex").toUpperCase();
const DAY = 86_400_000;

/** Simulator only: a buyer opens a dispute. Returns the new dispute ID. */
export async function simulateDispute(key?: string, openedDaysAgo = 0): Promise<string> {
  const scenario = (key && SCENARIO_BY_KEY.get(key)) || SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)];
  const built = buildCase(scenario, suffix(), openedDaysAgo);
  for (const order of [built.order, ...built.history]) await saveOrder(order);
  await simPutDispute(built.dispute);
  // Same entry point a PayPal webhook uses.
  await ingestDispute(built.dispute, "simulator");
  return built.dispute.dispute_id;
}

/** Create a scenario's records without queueing analysis, so an eval can run each engine itself. */
export async function simulateDisputeForEval(key: string): Promise<string> {
  const built = buildCase(SCENARIO_BY_KEY.get(key)!, suffix());
  for (const order of [built.order, ...built.history]) await saveOrder(order);
  await insertDispute(toRow(built.dispute, built.order));
  return built.dispute.dispute_id;
}

const CLAIM_TEXT: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "I never received this order.",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "The item is not what was described.",
  UNAUTHORISED: "I did not authorise this payment.",
};

/** Simulator only: the buyer of a demo-store order opens a dispute on it. */
export async function simulateDisputeForOrder(orderId: string, reason: string): Promise<string> {
  const order = await getOrder(orderId);
  if (!order?.capture_id) throw new Error("Order not found or not paid");
  if (!CLAIM_TEXT[reason]) throw new Error("Unsupported claim reason");
  const opened = new Date().toISOString();
  const doc: PayPalDispute = {
    dispute_id: `PP-D-${suffix()}`,
    create_time: opened,
    update_time: opened,
    reason,
    status: "WAITING_FOR_SELLER_RESPONSE",
    dispute_life_cycle_stage: reason === "UNAUTHORISED" ? "CHARGEBACK" : "INQUIRY",
    dispute_amount: { currency_code: order.currency, value: order.amount.toFixed(2) },
    seller_response_due_date: new Date(Date.now() + 10 * DAY).toISOString(),
    disputed_transactions: [
      { seller_transaction_id: order.capture_id, buyer: { name: order.buyer_name, email: order.buyer_email }, custom: order.id },
    ],
    messages: [{ posted_by: "BUYER", time_posted: opened, content: CLAIM_TEXT[reason] }],
  };
  await simPutDispute(doc);
  await ingestDispute(doc, "simulator");
  return doc.dispute_id;
}

const OPEN_SEED: Array<[key: string, openedDaysAgo: number]> = [
  ["cnp-return-received-no-refund", 8],
  ["inr-delivered-signed", 7],
  ["snad-minor-defect", 5],
  ["unauth-reshipped-new-account", 3],
  ["snad-buyers-remorse", 2],
  ["dup-real-double-charge", 1],
  ["inr-no-tracking", 0.2],
];

const HISTORY_SEED: Array<[key: string, openedDaysAgo: number, outcome: Outcome, buyer: string]> = [
  ["inr-delivered-signed", 54, "WON", "Hannah Weiss"],
  ["cnp-refund-already-issued", 49, "WON", "Carlos Rey"],
  ["inr-no-tracking", 45, "REFUNDED", "Aiko Tanaka"],
  ["snad-buyers-remorse", 40, "WON", "Ben Adler"],
  ["unauth-reshipped-new-account", 36, "REFUNDED", "Rosa Lindqvist"],
  ["dup-two-real-orders", 31, "WON", "Felix Brandao"],
  ["snad-minor-defect", 27, "SETTLED", "Nora Castellan"],
  ["unauth-established-buyer", 23, "LOST", "Jonas Albrecht"],
  ["inr-delivered-signed", 18, "WON", "Sofia Marchetti"],
  ["snad-wrong-item-admitted", 15, "REFUNDED", "Dmitri Vasko"],
  ["cnp-refund-already-issued", 12, "WON", "Elena Soto"],
];

const DECISION: Record<Outcome, Recommendation> = { WON: "FIGHT", LOST: "FIGHT", REFUNDED: "REFUND", SETTLED: "OFFER" };
const OUTCOME_CODE: Record<Outcome, string> = {
  WON: "RESOLVED_SELLER_FAVOUR",
  LOST: "RESOLVED_BUYER_FAVOUR",
  REFUNDED: "ACCEPTED",
  SETTLED: "RESOLVED_BUYER_FAVOUR",
};

async function seedResolved(scenario: Scenario, openedDaysAgo: number, outcome: Outcome, buyerName: string): Promise<void> {
  const buyer = { name: buyerName, email: `${buyerName.toLowerCase().replace(" ", ".")}@example.com` };
  const built = buildCase(scenario, suffix(), openedDaysAgo, Date.now(), buyer);
  for (const order of [built.order, ...built.history]) await saveOrder(order);

  const opened = Date.parse(built.dispute.create_time);
  const resolvedAt = new Date(opened + (outcome === "REFUNDED" ? 1 : 7) * DAY).toISOString();
  const doc = {
    ...built.dispute,
    status: "RESOLVED",
    update_time: resolvedAt,
    dispute_outcome: { outcome_code: OUTCOME_CODE[outcome] },
  };
  await simPutDispute(doc);

  const row = toRow(built.dispute, built.order);
  await insertDispute(row);
  const caseFile = await gatherCase(row);
  await updateDispute(row.id, {
    status: "RESOLVED",
    updated_at: resolvedAt,
    raw: doc,
    agent_status: "done",
    engine: "rules",
    verdict: rulesVerdict(caseFile),
    evidence_score: evidenceScore(caseFile),
    decision: DECISION[outcome],
    decided_by: "merchant",
    submitted_at: new Date(opened + DAY).toISOString(),
    outcome,
    resolved_at: resolvedAt,
  });
  await audit(row.id, "system", "seeded_history", { outcome });
}

const g = globalThis as unknown as { __deskSeeding?: Promise<void>; __deskPurging?: Promise<void> };

/**
 * Once real PayPal credentials are configured, simulator-made records must go: their
 * dispute IDs do not exist at PayPal, so acting on them would only produce errors.
 */
async function purgeSimulatorData(): Promise<void> {
  const db = await getDb();
  await db.exec(`
    DELETE FROM audit_log WHERE dispute_id IN (SELECT id FROM sim_disputes);
    DELETE FROM disputes WHERE id IN (SELECT id FROM sim_disputes);
    DELETE FROM orders WHERE capture_id LIKE 'CAP-%' OR capture_id LIKE 'SIMCAP-%';
    DELETE FROM sim_disputes;
  `);
}

/** Fill an empty simulator with a believable store: resolved history plus open disputes. */
export function ensureSeeded(): Promise<void> {
  if (isLivePayPal()) {
    return (g.__deskPurging ??= purgeSimulatorData().catch((err) => {
      g.__deskPurging = undefined;
      throw err;
    }));
  }
  return (g.__deskSeeding ??= (async () => {
    if ((await listDisputes()).length > 0) return;
    for (const [key, days, outcome, buyer] of HISTORY_SEED) {
      await seedResolved(SCENARIO_BY_KEY.get(key)!, days, outcome, buyer);
    }
    for (const [key, days] of OPEN_SEED) await simulateDispute(key, days);
  })());
}

export async function resetDemo(): Promise<void> {
  if (isLivePayPal()) throw new Error("Reset is only available in simulator mode");
  await g.__deskSeeding?.catch(() => {});
  await wipeAll();
  g.__deskSeeding = undefined;
  await ensureSeeded();
}
