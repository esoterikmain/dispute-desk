import type { PayPalGateway } from "./gateway";
import { livePayPal } from "./live";
import { simulatedPayPal } from "./simulator";

export type { PayPalGateway } from "./gateway";

export function isLivePayPal(): boolean {
  return !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

/** Live sandbox REST when PayPal credentials are configured, the local simulator otherwise. */
export function paypal(): PayPalGateway {
  return isLivePayPal() ? livePayPal : simulatedPayPal;
}
