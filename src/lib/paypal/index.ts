import { getDb } from "../db";
import type { PayPalGateway } from "./gateway";
import { livePayPal } from "./live";
import { simulatedPayPal } from "./simulator";

export type { PayPalGateway } from "./gateway";

export function isLivePayPal(): boolean {
  return !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

/** Sample cases (the simulator) stay available next to real PayPal unless DEMO_DATA=off. */
export function sampleCasesEnabled(): boolean {
  return !isLivePayPal() || process.env.DEMO_DATA !== "off";
}

/** Live sandbox REST when PayPal credentials are configured, the local simulator otherwise. */
export function paypal(): PayPalGateway {
  return isLivePayPal() ? livePayPal : simulatedPayPal;
}

/** The gateway that owns one dispute: sample cases always belong to the simulator. */
export async function gatewayFor(disputeId: string): Promise<PayPalGateway> {
  if (!isLivePayPal()) return simulatedPayPal;
  const db = await getDb();
  const rows = await db.query("SELECT 1 FROM sim_disputes WHERE id = $1", [disputeId]);
  return rows.length > 0 ? simulatedPayPal : livePayPal;
}
