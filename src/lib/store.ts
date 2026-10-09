import { randomBytes } from "node:crypto";
import { getDb } from "./db";
import { paypal } from "./paypal";
import { saveOrder } from "./repo";
import type { StoreOrder } from "./types";

// A three-product shop. It exists so real PayPal sandbox payments can be made, which
// gives the sandbox buyer something to dispute and gives the agent merchant records.

export const PRODUCTS = [
  { sku: "desk-organizer", name: "Walnut Desk Organizer", price: 189, description: "Solid walnut, 5 compartments" },
  { sku: "pour-over", name: "Ceramic Pour-Over Set", price: 46, description: "Dripper, carafe and two cups" },
  { sku: "pin-set", name: "Enamel Pin Set", price: 18.5, description: "Set of four, hard enamel" },
] as const;

/** How the order gets "shipped" after payment, so each dispute type has evidence to test against. */
export const FULFILMENTS = {
  delivered_signed: "Delivered, signed for",
  delivered: "Delivered, no signature",
  in_transit: "Shipped, stuck in transit",
  untracked: "Sent untracked",
} as const;
export type Fulfilment = keyof typeof FULFILMENTS;

const ref = () => `ORD-${randomBytes(4).toString("hex").toUpperCase()}`;

export async function createCheckout(cart: Array<{ sku: string; qty: number }>): Promise<{ paypalOrderId: string; orderId: string }> {
  const items = cart
    .map((line) => {
      const product = PRODUCTS.find((p) => p.sku === line.sku);
      const qty = Math.max(0, Math.min(10, Math.floor(line.qty)));
      return product && qty > 0 ? { name: product.name, qty, price: product.price, description: product.description } : null;
    })
    .filter((i) => i !== null);
  if (items.length === 0) throw new Error("The cart is empty");

  const orderId = ref();
  const created = await paypal().createOrder(items, "USD", orderId);
  await saveOrder({
    id: orderId,
    paypal_order_id: created.id,
    capture_id: "",
    buyer_name: "",
    buyer_email: "",
    placed_at: new Date().toISOString(),
    amount: items.reduce((sum, i) => sum + i.price * i.qty, 0),
    currency: "USD",
    items,
    shipping_address: "",
    shipment: null,
    messages: [],
    internal_notes: "Awaiting payment.",
  });
  return { paypalOrderId: created.id, orderId };
}

export async function captureCheckout(paypalOrderId: string, fulfilment: Fulfilment): Promise<StoreOrder> {
  const db = await getDb();
  const rows = await db.query<{ doc: StoreOrder }>("SELECT doc FROM orders WHERE doc->>'paypal_order_id' = $1", [paypalOrderId]);
  const order = rows[0]?.doc;
  if (!order) throw new Error("Unknown order");
  if (order.capture_id) return order;

  const gateway = paypal();
  const captured = await gateway.captureOrder(paypalOrderId);
  const now = Date.now();
  const iso = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
  const tracking = `1Z${randomBytes(8).toString("hex").toUpperCase()}`;
  const surname = captured.buyer_name.split(" ").slice(-1)[0]?.toUpperCase() ?? "BUYER";

  // Test fixture: the whole shipping timeline is squeezed into the three minutes after
  // payment, so the order can be disputed straight away without dates that contradict
  // PayPal's own payment time.
  const shipment: StoreOrder["shipment"] =
    fulfilment === "untracked"
      ? null
      : {
          carrier: "UPS",
          tracking_number: tracking,
          shipped_at: iso(1),
          events: [
            { at: iso(1), status: "Picked up by courier" },
            { at: iso(2), status: fulfilment === "in_transit" ? "In transit, arriving late" : "Out for delivery" },
          ],
        };
  if (shipment && fulfilment !== "in_transit") {
    const signed = fulfilment === "delivered_signed" ? `${captured.buyer_name[0]}. ${surname}` : undefined;
    shipment.delivered_at = iso(3);
    shipment.signed_by = signed;
    shipment.events.push({ at: iso(3), status: signed ? `Delivered - signed for by ${signed}` : "Delivered - front door" });
  }

  const paid: StoreOrder = {
    ...order,
    capture_id: captured.capture_id,
    buyer_name: captured.buyer_name,
    buyer_email: captured.buyer_email,
    shipping_address: captured.shipping_address,
    address_matches_account: true,
    shipment,
    internal_notes:
      (fulfilment === "untracked" ? "Sent by untracked letter mail. " : "") +
      "Sandbox test order: same-day courier, shipping timeline compressed to minutes.",
  };
  await saveOrder(paid);

  if (shipment && gateway.mode === "live") {
    // Best effort: the dispute evidence does not depend on PayPal also holding the tracking number.
    await gateway
      .addTracking(paypalOrderId, captured.capture_id, shipment.carrier, shipment.tracking_number)
      .catch((err) => console.error("[store] could not add tracking to PayPal", err));
  }
  return paid;
}
