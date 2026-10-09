import type { PayPalDispute } from "../types";

export interface EvidenceSubmission {
  notes: string;
  evidenceType: string;
  tracking?: { carrier: string; number: string };
  pdf?: Uint8Array;
  /**
   * Which PayPal action to file under. A dispute waiting on the seller takes
   * provide-evidence; one already under PayPal review only accepts supporting info.
   */
  as?: "evidence" | "supporting_info";
}

export interface CheckoutItem {
  name: string;
  qty: number;
  price: number;
}

export interface CapturedOrder {
  paypal_order_id: string;
  capture_id: string;
  buyer_name: string;
  buyer_email: string;
  shipping_address: string;
}

/** Everything Dispute Desk asks of PayPal. Two implementations: live REST and a local simulator. */
export interface PayPalGateway {
  mode: "live" | "simulator";
  listDisputes(): Promise<PayPalDispute[]>;
  getDispute(id: string): Promise<PayPalDispute>;
  provideEvidence(id: string, evidence: EvidenceSubmission): Promise<void>;
  acceptClaim(id: string, note: string): Promise<void>;
  makeOffer(id: string, offer: { amount: number; currency: string; note: string }): Promise<void>;
  sendMessage(id: string, message: string): Promise<void>;
  /** Sandbox-only: move a claim under review to "waiting for seller evidence". */
  requireSellerEvidence(id: string): Promise<void>;
  /** Sandbox-only: force PayPal's decision so a full lifecycle can be shown in minutes. */
  adjudicate(id: string, outcome: "SELLER_FAVOR" | "BUYER_FAVOR"): Promise<void>;
  createOrder(items: CheckoutItem[], currency: string, reference: string): Promise<{ id: string }>;
  captureOrder(paypalOrderId: string): Promise<CapturedOrder>;
  addTracking(paypalOrderId: string, captureId: string, carrier: string, trackingNumber: string): Promise<void>;
  verifyWebhook(headers: Headers, event: unknown): Promise<boolean>;
}
