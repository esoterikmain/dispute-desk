import { randomBytes } from "node:crypto";
import { getDb } from "../db";
import type { PayPalDispute } from "../types";
import type { PayPalGateway } from "./gateway";

// A stand-in for PayPal that keeps dispute documents in the local database, in PayPal's
// own JSON shape. It lets the whole app run with no PayPal credentials; the ingest,
// agent and action code paths are the same ones the live gateway uses.

const id = (prefix: string) => `${prefix}-${randomBytes(6).toString("hex").toUpperCase()}`;

async function load(disputeId: string): Promise<PayPalDispute> {
  const db = await getDb();
  const rows = await db.query<{ doc: PayPalDispute }>("SELECT doc FROM sim_disputes WHERE id = $1", [disputeId]);
  if (!rows[0]) throw new Error(`Simulated dispute ${disputeId} not found`);
  return rows[0].doc;
}

export async function simPutDispute(doc: PayPalDispute): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO sim_disputes (id, doc) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET doc = $2::jsonb`,
    [doc.dispute_id, JSON.stringify(doc)],
  );
}

async function mutate(disputeId: string, change: (doc: PayPalDispute) => void): Promise<void> {
  const doc = await load(disputeId);
  change(doc);
  doc.update_time = new Date().toISOString();
  await simPutDispute(doc);
}

const sellerMessage = (doc: PayPalDispute, content: string) => {
  doc.messages = [...(doc.messages ?? []), { posted_by: "SELLER", time_posted: new Date().toISOString(), content }];
};

export const simulatedPayPal: PayPalGateway = {
  mode: "simulator",

  async listDisputes() {
    const db = await getDb();
    const rows = await db.query<{ doc: PayPalDispute }>("SELECT doc FROM sim_disputes");
    return rows.map((r) => r.doc);
  },

  getDispute: load,

  provideEvidence: (disputeId, evidence) =>
    mutate(disputeId, (doc) => {
      doc.status = "UNDER_REVIEW";
      doc.evidences = [
        ...(doc.evidences ?? []),
        { evidence_type: evidence.evidenceType, notes: evidence.notes, tracking: evidence.tracking, has_document: !!evidence.pdf },
      ];
    }),

  acceptClaim: (disputeId, note) =>
    mutate(disputeId, (doc) => {
      doc.status = "RESOLVED";
      doc.dispute_outcome = { outcome_code: "ACCEPTED", amount_refunded: doc.dispute_amount };
      sellerMessage(doc, note);
    }),

  makeOffer: (disputeId, offer) =>
    mutate(disputeId, (doc) => {
      doc.status = "WAITING_FOR_BUYER_RESPONSE";
      doc.offer = { seller_offered_amount: { currency_code: offer.currency, value: offer.amount.toFixed(2) } };
      sellerMessage(doc, offer.note);
    }),

  sendMessage: (disputeId, message) => mutate(disputeId, (doc) => sellerMessage(doc, message)),

  async requireSellerEvidence() {},

  adjudicate: (disputeId, outcome) =>
    mutate(disputeId, (doc) => {
      doc.status = "RESOLVED";
      if (outcome === "SELLER_FAVOR") {
        doc.dispute_outcome = { outcome_code: "RESOLVED_SELLER_FAVOUR" };
      } else {
        // A buyer who accepts a partial-refund offer is refunded the offered amount only.
        doc.dispute_outcome = {
          outcome_code: "RESOLVED_BUYER_FAVOUR",
          amount_refunded: doc.offer?.seller_offered_amount ?? doc.dispute_amount,
        };
      }
    }),

  async createOrder() {
    return { id: id("SIMORDER") };
  },

  async captureOrder(paypalOrderId) {
    return {
      paypal_order_id: paypalOrderId,
      capture_id: id("SIMCAP"),
      buyer_name: "Sam Sandbox",
      buyer_email: "sam.sandbox@example.com",
      shipping_address: "1 Main St, San Jose, CA, 95131, US",
    };
  },

  async addTracking() {},

  // Simulated events never leave this process, so there is no signature to check.
  async verifyWebhook() {
    return true;
  },
};
