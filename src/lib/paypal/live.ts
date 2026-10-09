import type { PayPalDispute } from "../types";
import type { CapturedOrder, CheckoutItem, EvidenceSubmission, PayPalGateway } from "./gateway";

const BASE = process.env.PAYPAL_API_BASE ?? "https://api-m.sandbox.paypal.com";

export class PayPalApiError extends Error {
  constructor(
    public status: number,
    public body: string,
    path: string,
  ) {
    super(`PayPal ${status} on ${path}: ${body.slice(0, 400)}`);
  }
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new PayPalApiError(res.status, await res.text(), "/v1/oauth2/token");
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cachedToken.value;
}

async function call<T>(path: string, init: { method?: string; json?: unknown; form?: FormData } = {}): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await accessToken()}` };
  let body: BodyInit | undefined;
  if (init.form) {
    body = init.form;
  } else if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`${BASE}${path}`, { method: init.method ?? "GET", headers, body });
  const text = await res.text();
  if (!res.ok) throw new PayPalApiError(res.status, text, path);
  return (text ? JSON.parse(text) : {}) as T;
}

const money = (n: number) => n.toFixed(2);
const dispute = (id: string) => `/v1/customer/disputes/${encodeURIComponent(id)}`;

export const livePayPal: PayPalGateway = {
  mode: "live",

  async listDisputes() {
    const res = await call<{ items?: PayPalDispute[] }>("/v1/customer/disputes?page_size=50");
    return res.items ?? [];
  },

  getDispute: (id) => call<PayPalDispute>(dispute(id)),

  async provideEvidence(id, evidence: EvidenceSubmission) {
    const entry: Record<string, unknown> = { evidence_type: evidence.evidenceType, notes: evidence.notes.slice(0, 2000) };
    if (evidence.tracking) {
      entry.evidence_info = {
        tracking_info: [{ carrier_name: evidence.tracking.carrier, tracking_number: evidence.tracking.number }],
      };
    }
    const supporting = evidence.as === "supporting_info";
    const input = supporting ? { notes: evidence.notes.slice(0, 2000) } : { evidences: [entry] };
    const form = new FormData();
    form.append("input", new Blob([JSON.stringify(input)], { type: "application/json" }));
    if (evidence.pdf) {
      form.append("file1", new Blob([evidence.pdf as BlobPart], { type: "application/pdf" }), "evidence.pdf");
    }
    await call(`${dispute(id)}/${supporting ? "provide-supporting-info" : "provide-evidence"}`, { method: "POST", form });
  },

  async acceptClaim(id, note) {
    await call(`${dispute(id)}/accept-claim`, { method: "POST", json: { note: note.slice(0, 2000) } });
  },

  async makeOffer(id, offer) {
    await call(`${dispute(id)}/make-offer`, {
      method: "POST",
      json: {
        note: offer.note.slice(0, 2000),
        offer_type: "REFUND",
        offer_amount: { currency_code: offer.currency, value: money(offer.amount) },
      },
    });
  },

  async sendMessage(id, message) {
    await call(`${dispute(id)}/send-message`, { method: "POST", json: { message: message.slice(0, 2000) } });
  },

  async requireSellerEvidence(id) {
    await call(`${dispute(id)}/require-evidence`, { method: "POST", json: { action: "SELLER_EVIDENCE" } });
  },

  async adjudicate(id, outcome) {
    await call(`${dispute(id)}/adjudicate`, { method: "POST", json: { adjudication_outcome: outcome } });
  },

  async createOrder(items: CheckoutItem[], currency, reference) {
    const total = items.reduce((sum, i) => sum + i.price * i.qty, 0);
    return call<{ id: string }>("/v2/checkout/orders", {
      method: "POST",
      json: {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: reference,
            custom_id: reference,
            amount: {
              currency_code: currency,
              value: money(total),
              breakdown: { item_total: { currency_code: currency, value: money(total) } },
            },
            items: items.map((i) => ({
              name: i.name,
              quantity: String(i.qty),
              unit_amount: { currency_code: currency, value: money(i.price) },
            })),
          },
        ],
      },
    });
  },

  async captureOrder(paypalOrderId): Promise<CapturedOrder> {
    type Capture = {
      payer?: { name?: { given_name?: string; surname?: string }; email_address?: string };
      purchase_units?: Array<{
        shipping?: { address?: Record<string, string> };
        payments?: { captures?: Array<{ id: string }> };
      }>;
    };
    const res = await call<Capture>(`/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
      method: "POST",
      json: {},
    });
    const unit = res.purchase_units?.[0];
    const address = unit?.shipping?.address;
    return {
      paypal_order_id: paypalOrderId,
      capture_id: unit?.payments?.captures?.[0]?.id ?? "",
      buyer_name: [res.payer?.name?.given_name, res.payer?.name?.surname].filter(Boolean).join(" ") || "PayPal buyer",
      buyer_email: res.payer?.email_address ?? "",
      shipping_address: address
        ? [address.address_line_1, address.admin_area_2, address.admin_area_1, address.postal_code, address.country_code]
            .filter(Boolean)
            .join(", ")
        : "",
    };
  },

  async addTracking(paypalOrderId, captureId, carrier, trackingNumber) {
    await call(`/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/track`, {
      method: "POST",
      json: { capture_id: captureId, tracking_number: trackingNumber, carrier, notify_payer: false },
    });
  },

  async verifyWebhook(headers, event) {
    const webhookId = process.env.PAYPAL_WEBHOOK_ID;
    if (!webhookId) return false;
    const res = await call<{ verification_status: string }>("/v1/notifications/verify-webhook-signature", {
      method: "POST",
      json: {
        auth_algo: headers.get("paypal-auth-algo"),
        cert_url: headers.get("paypal-cert-url"),
        transmission_id: headers.get("paypal-transmission-id"),
        transmission_sig: headers.get("paypal-transmission-sig"),
        transmission_time: headers.get("paypal-transmission-time"),
        webhook_id: webhookId,
        webhook_event: event,
      },
    });
    return res.verification_status === "SUCCESS";
  },
};
