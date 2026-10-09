import { getDb } from "../db";
import { getOrder, getOrderByCapture, listOrdersByBuyer } from "../repo";
import type { DisputeRow, StoreOrder } from "../types";

/** Everything known about one dispute, assembled from PayPal and the merchant's own records. */
export interface CaseFile {
  dispute: {
    id: string;
    reason: string;
    status: string;
    stage: string | null;
    amount: number;
    currency: string;
    opened_at: string;
    response_due: string | null;
    buyer_name: string | null;
    buyer_email: string | null;
    transaction_id: string | null;
    paypal_messages: Array<{ posted_by: string; time_posted: string; content: string }>;
  };
  order: StoreOrder | null;
  buyer_history: {
    other_orders: Array<{
      id: string;
      placed_at: string;
      amount: number;
      items: string[];
      shipping_address: string;
      delivered: boolean;
      internal_notes?: string;
    }>;
    prior_disputes: Array<{ id: string; reason: string; opened_at: string; outcome: string | null; amount: number }>;
  };
}

export function disputeSummary(d: DisputeRow): CaseFile["dispute"] {
  return {
    id: d.id,
    reason: d.reason,
    status: d.status,
    stage: d.stage,
    amount: d.amount,
    currency: d.currency,
    opened_at: d.created_at,
    response_due: d.response_due,
    buyer_name: d.buyer_name,
    buyer_email: d.buyer_email,
    transaction_id: d.transaction_id,
    paypal_messages: d.raw.messages ?? [],
  };
}

export async function findOrder(d: DisputeRow): Promise<StoreOrder | null> {
  if (d.order_id) {
    const byId = await getOrder(d.order_id);
    if (byId) return byId;
  }
  return d.transaction_id ? getOrderByCapture(d.transaction_id) : null;
}

export async function buyerHistory(d: DisputeRow, order: StoreOrder | null): Promise<CaseFile["buyer_history"]> {
  const email = d.buyer_email ?? order?.buyer_email;
  if (!email) return { other_orders: [], prior_disputes: [] };
  const orders = (await listOrdersByBuyer(email)).filter((o) => o.id !== order?.id);
  const db = await getDb();
  const disputes = await db.query<{ id: string; reason: string; created_at: string; outcome: string | null; amount: number }>(
    "SELECT id, reason, created_at, outcome, amount FROM disputes WHERE buyer_email = $1 AND id <> $2 ORDER BY created_at DESC",
    [email, d.id],
  );
  return {
    other_orders: orders.map((o) => ({
      id: o.id,
      placed_at: o.placed_at,
      amount: o.amount,
      items: o.items.map((i) => `${i.qty} x ${i.name}`),
      shipping_address: o.shipping_address,
      delivered: !!o.shipment?.delivered_at,
      internal_notes: o.internal_notes,
    })),
    prior_disputes: disputes.map((p) => ({
      id: p.id,
      reason: p.reason,
      opened_at: p.created_at,
      outcome: p.outcome,
      amount: p.amount,
    })),
  };
}

export async function gatherCase(d: DisputeRow): Promise<CaseFile> {
  const order = await findOrder(d);
  return { dispute: disputeSummary(d), order, buyer_history: await buyerHistory(d, order) };
}

/**
 * How complete the evidence is for this kind of claim, 0-100. This is a checklist of
 * what PayPal asks sellers for, independent of whether the evidence helps or hurts.
 */
export function evidenceScore(c: CaseFile): number {
  const o = c.order;
  if (!o) return 0;
  const checks: boolean[] = [true]; // order record found
  switch (c.dispute.reason) {
    case "MERCHANDISE_OR_SERVICE_NOT_RECEIVED":
      checks.push(!!o.shipment, !!o.shipment?.delivered_at, !!o.shipment?.signed_by, o.address_matches_account === true);
      break;
    case "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED":
      checks.push(o.items.some((i) => !!i.description), (o.messages?.length ?? 0) > 0, !!o.shipment?.delivered_at);
      break;
    case "UNAUTHORISED":
      checks.push(
        !!o.shipment?.delivered_at,
        o.address_matches_account === true,
        o.risk?.avs_match === true,
        c.buyer_history.other_orders.length > 0,
      );
      break;
    case "DUPLICATE_TRANSACTION":
      checks.push(c.buyer_history.other_orders.length > 0, !!o.shipment, !!o.internal_notes);
      break;
    case "CREDIT_NOT_PROCESSED":
      checks.push((o.refunds?.length ?? 0) > 0, !!o.return_received_at, (o.messages?.length ?? 0) > 0);
      break;
    default:
      checks.push(!!o.shipment, (o.messages?.length ?? 0) > 0);
  }
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}
