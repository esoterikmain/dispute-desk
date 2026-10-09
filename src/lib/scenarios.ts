import type { PayPalDispute, Recommendation, StoreOrder } from "./types";

// Hand-written dispute cases. They drive three things: the simulator's "new dispute"
// button, the seeded demo data, and the agent eval (each case carries the decision a
// careful human would make).

export interface Scenario {
  key: string;
  title: string;
  expected: Recommendation;
  /** Why a human would decide that way; shown in the eval report. */
  rationale: string;
  reason: string;
  amount: number;
  buyer: { name: string; email: string };
  buyerClaim: string;
  /** Extra orders by the same buyer, to give the agent history to find. */
  history?: Array<Partial<StoreOrder> & { daysAgo: number; amount: number }>;
  order: (t: Clock) => Omit<StoreOrder, "id" | "capture_id" | "buyer_name" | "buyer_email" | "amount" | "currency">;
}

export interface Clock {
  /** ISO timestamp `days` before the dispute was opened. */
  ago(days: number, hours?: number): string;
}

const addr = {
  maya: "48 Larkin Way, Portland, OR 97205, US",
  owen: "910 Birch Ct, Austin, TX 78704, US",
  priya: "17 Canal St, Brooklyn, NY 11201, US",
  leo: "3302 Alder Ave, Seattle, WA 98107, US",
  ines: "77 Mission Rd, Tucson, AZ 85701, US",
  tom: "5 Quarry Ln, Denver, CO 80211, US",
};

export const SCENARIOS: Scenario[] = [
  {
    key: "inr-delivered-signed",
    title: "Item not received, but delivered with signature",
    expected: "FIGHT",
    rationale: "Carrier shows delivery to the account address with the buyer's signature.",
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    amount: 189.0,
    buyer: { name: "Maya Fischer", email: "maya.fischer@example.com" },
    buyerClaim: "I never received my order. It has been over two weeks.",
    order: (t) => ({
      placed_at: t.ago(16),
      items: [{ name: "Walnut Desk Organizer", qty: 1, price: 189.0, description: "Solid walnut, 5 compartments" }],
      shipping_address: addr.maya,
      address_matches_account: true,
      shipment: {
        carrier: "FEDEX",
        tracking_number: "784512369874",
        shipped_at: t.ago(15),
        delivered_at: t.ago(12),
        signed_by: "M. FISCHER",
        events: [
          { at: t.ago(15), status: "Picked up", location: "Sacramento, CA" },
          { at: t.ago(13), status: "In transit", location: "Troutdale, OR" },
          { at: t.ago(12), status: "Delivered - signed for by M. FISCHER", location: "Portland, OR" },
        ],
      },
      risk: { account_age_days: 1340, prior_orders: 2, avs_match: true, ip_country: "US" },
      messages: [],
    }),
  },
  {
    key: "inr-no-tracking",
    title: "Item not received, shipped untracked",
    expected: "REFUND",
    rationale: "No proof of shipment or delivery exists, so the claim cannot be defended.",
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    amount: 18.5,
    buyer: { name: "Owen Brandt", email: "owen.brandt@example.com" },
    buyerClaim: "Order never arrived and the seller has no tracking number.",
    order: (t) => ({
      placed_at: t.ago(24),
      items: [{ name: "Enamel Pin Set", qty: 1, price: 18.5 }],
      shipping_address: addr.owen,
      address_matches_account: true,
      shipment: null,
      risk: { account_age_days: 410, prior_orders: 0, avs_match: true, ip_country: "US" },
      messages: [
        { from: "buyer", at: t.ago(6), body: "Hi, is there a tracking number for my pins?" },
        { from: "merchant", at: t.ago(5), body: "Sorry, small items go by untracked letter mail. It should arrive soon." },
      ],
      internal_notes: "Sent by untracked letter mail. No postage receipt kept.",
    }),
  },
  {
    key: "inr-stuck-in-transit",
    title: "Item not received, parcel stalled for 12 days",
    expected: "REFUND",
    rationale: "Tracking confirms the parcel never arrived; the carrier lost it.",
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    amount: 74.0,
    buyer: { name: "Priya Nair", email: "priya.nair@example.com" },
    buyerClaim: "Tracking has not moved in almost two weeks. I want my money back.",
    order: (t) => ({
      placed_at: t.ago(19),
      items: [{ name: "Linen Table Runner", qty: 2, price: 37.0 }],
      shipping_address: addr.priya,
      address_matches_account: true,
      shipment: {
        carrier: "USPS",
        tracking_number: "9400111899223857461234",
        shipped_at: t.ago(18),
        events: [
          { at: t.ago(18), status: "Accepted at origin facility", location: "Oakland, CA" },
          { at: t.ago(14), status: "Arrived at regional facility", location: "Jersey City, NJ" },
          { at: t.ago(12), status: "In transit, arriving late", location: "Jersey City, NJ" },
        ],
      },
      risk: { account_age_days: 890, prior_orders: 4, avs_match: true, ip_country: "US" },
      messages: [{ from: "buyer", at: t.ago(3), body: "The tracking page still says arriving late. Any update?" }],
    }),
  },
  {
    key: "snad-buyers-remorse",
    title: "Not as described, but buyer said they changed their mind",
    expected: "FIGHT",
    rationale: "Buyer's own messages confirm the item matches the listing and that they no longer want it.",
    reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
    amount: 132.0,
    buyer: { name: "Leo Hartmann", email: "leo.hartmann@example.com" },
    buyerClaim: "The lamp is not as described.",
    order: (t) => ({
      placed_at: t.ago(21),
      items: [{ name: "Brass Arc Floor Lamp", qty: 1, price: 132.0, description: "Brushed brass, 160 cm, E27 socket, bulb not included" }],
      shipping_address: addr.leo,
      address_matches_account: true,
      shipment: {
        carrier: "UPS",
        tracking_number: "1Z999AA10123456784",
        shipped_at: t.ago(20),
        delivered_at: t.ago(17),
        events: [
          { at: t.ago(20), status: "Shipped", location: "Reno, NV" },
          { at: t.ago(17), status: "Delivered - front door", location: "Seattle, WA" },
        ],
      },
      risk: { account_age_days: 2200, prior_orders: 1, avs_match: true, ip_country: "US" },
      messages: [
        { from: "buyer", at: t.ago(15), body: "Lamp arrived, looks exactly like the photos. Honestly though I found a cheaper one and I've changed my mind. Can I get a refund without sending it back?" },
        { from: "merchant", at: t.ago(15), body: "Glad it arrived safely. We accept returns within 30 days: send it back and we refund in full. Return label attached." },
        { from: "buyer", at: t.ago(14), body: "I don't want to pay to box it up. I'll just dispute it." },
      ],
    }),
  },
  {
    key: "snad-wrong-item-admitted",
    title: "Not as described, merchant shipped the wrong item",
    expected: "REFUND",
    rationale: "The merchant's own reply admits the wrong variant was sent.",
    reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
    amount: 58.0,
    buyer: { name: "Ines Moreno", email: "ines.moreno@example.com" },
    buyerClaim: "I ordered the blue throw and received a grey one.",
    order: (t) => ({
      placed_at: t.ago(11),
      items: [{ name: "Wool Throw - Indigo Blue", qty: 1, price: 58.0 }],
      shipping_address: addr.ines,
      address_matches_account: true,
      shipment: {
        carrier: "USPS",
        tracking_number: "9405511899561234567890",
        shipped_at: t.ago(10),
        delivered_at: t.ago(7),
        events: [
          { at: t.ago(10), status: "Shipped", location: "Oakland, CA" },
          { at: t.ago(7), status: "Delivered - mailbox", location: "Tucson, AZ" },
        ],
      },
      risk: { account_age_days: 600, prior_orders: 3, avs_match: true, ip_country: "US" },
      messages: [
        { from: "buyer", at: t.ago(6), body: "This is grey, not indigo. Photo attached." },
        { from: "merchant", at: t.ago(5), body: "You're right, our packer pulled the wrong colour. We're out of indigo until next month, sorry." },
      ],
      internal_notes: "Pick error confirmed by warehouse. Indigo out of stock.",
    }),
  },
  {
    key: "snad-minor-defect",
    title: "Not as described, small cosmetic defect on a pricey item",
    expected: "OFFER",
    rationale: "A real but minor defect; the buyer asked for a partial refund and wants to keep the item.",
    reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
    amount: 240.0,
    buyer: { name: "Tom Okafor", email: "tom.okafor@example.com" },
    buyerClaim: "The cabinet arrived with a scratch on the side panel.",
    order: (t) => ({
      placed_at: t.ago(13),
      items: [{ name: "Oak Record Cabinet", qty: 1, price: 240.0, description: "Solid oak, holds 120 LPs" }],
      shipping_address: addr.tom,
      address_matches_account: true,
      shipment: {
        carrier: "UPS",
        tracking_number: "1Z999AA10987654321",
        shipped_at: t.ago(12),
        delivered_at: t.ago(8),
        events: [
          { at: t.ago(12), status: "Shipped", location: "Reno, NV" },
          { at: t.ago(8), status: "Delivered", location: "Denver, CO" },
        ],
      },
      risk: { account_age_days: 1500, prior_orders: 5, avs_match: true, ip_country: "US" },
      messages: [
        { from: "buyer", at: t.ago(7), body: "Love the cabinet but there's a 10 cm scratch on the left panel. I'd rather keep it than ship it back. Could you knock something off the price?" },
        { from: "merchant", at: t.ago(7), body: "Sorry about that. Let me check what we can do." },
      ],
      internal_notes: "Scratch visible in buyer photo. Return freight would cost about $85.",
    }),
  },
  {
    key: "unauth-established-buyer",
    title: "Unauthorized claim from a long-standing customer",
    expected: "FIGHT",
    rationale: "Delivered to the account address, matching earlier undisputed orders, and the buyer messaged about the order afterwards.",
    reason: "UNAUTHORISED",
    amount: 312.0,
    buyer: { name: "Maya Fischer", email: "maya.fischer@example.com" },
    buyerClaim: "I did not make this purchase.",
    history: [
      { daysAgo: 140, amount: 64.0, shipping_address: addr.maya },
      { daysAgo: 60, amount: 119.0, shipping_address: addr.maya },
    ],
    order: (t) => ({
      placed_at: t.ago(9),
      items: [{ name: "Leather Weekender Bag", qty: 1, price: 312.0 }],
      shipping_address: addr.maya,
      address_matches_account: true,
      shipment: {
        carrier: "FEDEX",
        tracking_number: "784598761230",
        shipped_at: t.ago(8),
        delivered_at: t.ago(5),
        signed_by: "M. FISCHER",
        events: [
          { at: t.ago(8), status: "Picked up", location: "Sacramento, CA" },
          { at: t.ago(5), status: "Delivered - signed for by M. FISCHER", location: "Portland, OR" },
        ],
      },
      risk: { account_age_days: 1340, prior_orders: 2, avs_match: true, ip_country: "US" },
      messages: [{ from: "buyer", at: t.ago(4), body: "Bag arrived today. Do you sell a matching toiletry case?" }],
    }),
  },
  {
    key: "unauth-reshipped-new-account",
    title: "Unauthorized claim, new account, shipped to a different address",
    expected: "REFUND",
    rationale: "Classic account-takeover pattern; shipping to a non-account address forfeits seller protection.",
    reason: "UNAUTHORISED",
    amount: 449.0,
    buyer: { name: "Dana Whitlock", email: "dana.whitlock@example.com" },
    buyerClaim: "Someone used my PayPal account without my permission.",
    order: (t) => ({
      placed_at: t.ago(6),
      items: [{ name: "Noise-Cancelling Headphones", qty: 1, price: 449.0 }],
      shipping_address: "Unit 14, 2200 Freight Blvd, Miami, FL 33166, US (freight forwarder)",
      address_matches_account: false,
      shipment: {
        carrier: "UPS",
        tracking_number: "1Z999AA10555512345",
        shipped_at: t.ago(6),
        delivered_at: t.ago(4),
        events: [
          { at: t.ago(6), status: "Shipped - next day air", location: "Reno, NV" },
          { at: t.ago(4), status: "Delivered - dock", location: "Miami, FL" },
        ],
      },
      risk: { account_age_days: 3, prior_orders: 0, avs_match: false, ip_country: "RO" },
      messages: [{ from: "buyer", at: t.ago(6), body: "pls ship fastest possible today, will pay extra" }],
      internal_notes: "Address changed at checkout after payment page loaded.",
    }),
  },
  {
    key: "dup-real-double-charge",
    title: "Duplicate charge, the buyer really was charged twice",
    expected: "REFUND",
    rationale: "Two captures for one order two minutes apart; only one parcel shipped.",
    reason: "DUPLICATE_TRANSACTION",
    amount: 46.0,
    buyer: { name: "Priya Nair", email: "priya.nair@example.com" },
    buyerClaim: "I was charged twice for the same order.",
    history: [
      {
        daysAgo: 5,
        amount: 46.0,
        items: [{ name: "Ceramic Pour-Over Set", qty: 1, price: 46.0 }],
        internal_notes: "First capture for cart #8841. Shipped.",
      },
    ],
    order: (t) => ({
      placed_at: t.ago(5, -0.03),
      items: [{ name: "Ceramic Pour-Over Set", qty: 1, price: 46.0 }],
      shipping_address: addr.priya,
      address_matches_account: true,
      shipment: null,
      risk: { account_age_days: 890, prior_orders: 4, avs_match: true, ip_country: "US" },
      messages: [{ from: "buyer", at: t.ago(4), body: "My card shows two charges of $46 but I ordered one set." }],
      internal_notes: "Second capture for the same cart #8841, 2 minutes after the first. Checkout retry bug. Nothing shipped for this capture.",
    }),
  },
  {
    key: "dup-two-real-orders",
    title: "Duplicate charge claim, but two separate orders were delivered",
    expected: "FIGHT",
    rationale: "Two different orders with different items, both delivered.",
    reason: "DUPLICATE_TRANSACTION",
    amount: 82.0,
    buyer: { name: "Leo Hartmann", email: "leo.hartmann@example.com" },
    buyerClaim: "I was billed twice.",
    history: [
      {
        daysAgo: 12,
        amount: 95.0,
        items: [{ name: "Copper Kettle", qty: 1, price: 95.0 }],
        internal_notes: "Separate cart #9120. Delivered.",
      },
    ],
    order: (t) => ({
      placed_at: t.ago(10),
      items: [{ name: "Cast Iron Trivet", qty: 2, price: 41.0 }],
      shipping_address: addr.leo,
      address_matches_account: true,
      shipment: {
        carrier: "UPS",
        tracking_number: "1Z999AA10222233334",
        shipped_at: t.ago(9),
        delivered_at: t.ago(6),
        events: [
          { at: t.ago(9), status: "Shipped", location: "Reno, NV" },
          { at: t.ago(6), status: "Delivered - front door", location: "Seattle, WA" },
        ],
      },
      risk: { account_age_days: 2200, prior_orders: 2, avs_match: true, ip_country: "US" },
      messages: [],
      internal_notes: "Cart #9155, placed two days after cart #9120. Different items, different amount.",
    }),
  },
  {
    key: "cnp-refund-already-issued",
    title: "Refund not received, but the refund was already issued",
    expected: "FIGHT",
    rationale: "A full refund with a PayPal refund ID was issued before the dispute was opened.",
    reason: "CREDIT_NOT_PROCESSED",
    amount: 67.0,
    buyer: { name: "Ines Moreno", email: "ines.moreno@example.com" },
    buyerClaim: "I returned the item and never got my refund.",
    order: (t) => ({
      placed_at: t.ago(30),
      items: [{ name: "Stoneware Planter", qty: 1, price: 67.0 }],
      shipping_address: addr.ines,
      address_matches_account: true,
      shipment: {
        carrier: "USPS",
        tracking_number: "9405511899560000111122",
        shipped_at: t.ago(29),
        delivered_at: t.ago(26),
        events: [{ at: t.ago(26), status: "Delivered", location: "Tucson, AZ" }],
      },
      return_received_at: t.ago(8),
      refunds: [{ id: "REF-7QK20391XL", amount: 67.0, at: t.ago(7) }],
      risk: { account_age_days: 600, prior_orders: 3, avs_match: true, ip_country: "US" },
      messages: [{ from: "merchant", at: t.ago(7), body: "Return received, thank you. Full refund of $67.00 issued today (PayPal refund REF-7QK20391XL)." }],
    }),
  },
  {
    key: "cnp-return-received-no-refund",
    title: "Refund not received, return arrived but nobody refunded it",
    expected: "REFUND",
    rationale: "The return was received 11 days ago and no refund was ever issued.",
    reason: "CREDIT_NOT_PROCESSED",
    amount: 94.0,
    buyer: { name: "Tom Okafor", email: "tom.okafor@example.com" },
    buyerClaim: "You received my return over a week ago. Where is my refund?",
    order: (t) => ({
      placed_at: t.ago(34),
      items: [{ name: "Merino Cardigan", qty: 1, price: 94.0 }],
      shipping_address: addr.tom,
      address_matches_account: true,
      shipment: {
        carrier: "UPS",
        tracking_number: "1Z999AA10777788889",
        shipped_at: t.ago(33),
        delivered_at: t.ago(30),
        events: [{ at: t.ago(30), status: "Delivered", location: "Denver, CO" }],
      },
      return_received_at: t.ago(11),
      refunds: [],
      risk: { account_age_days: 1500, prior_orders: 5, avs_match: true, ip_country: "US" },
      messages: [
        { from: "buyer", at: t.ago(9), body: "Tracking shows my return was delivered to you. When will I be refunded?" },
        { from: "buyer", at: t.ago(3), body: "Still nothing. Opening a dispute." },
      ],
      internal_notes: "Return checked in at warehouse. Refund ticket never actioned.",
    }),
  },
];

export const SCENARIO_BY_KEY = new Map(SCENARIOS.map((s) => [s.key, s]));

export interface BuiltCase {
  order: StoreOrder;
  history: StoreOrder[];
  dispute: PayPalDispute;
}

/**
 * Turn a scenario into concrete records. `openedDaysAgo` backdates the dispute, which
 * the seeder uses to build a resolved history.
 */
export function buildCase(
  scenario: Scenario,
  suffix: string,
  openedDaysAgo = 0,
  now = Date.now(),
  buyer = scenario.buyer,
): BuiltCase {
  const opened = now - openedDaysAgo * 86_400_000;
  const clock: Clock = {
    ago: (days, hours = 0) => new Date(opened - days * 86_400_000 - hours * 3_600_000).toISOString(),
  };
  const captureId = `CAP-${suffix}`;
  const order: StoreOrder = {
    id: `ORD-${suffix}`,
    capture_id: captureId,
    buyer_name: buyer.name,
    buyer_email: buyer.email,
    amount: scenario.amount,
    currency: "USD",
    ...scenario.order(clock),
  };
  if (buyer !== scenario.buyer && order.shipment?.signed_by) {
    // Keep the delivery signature consistent when a scenario is replayed for another buyer.
    const [first, ...rest] = buyer.name.split(" ");
    const signature = `${first[0]}. ${rest.join(" ").toUpperCase()}`;
    const original = order.shipment.signed_by;
    order.shipment.signed_by = signature;
    order.shipment.events = order.shipment.events.map((e) => ({ ...e, status: e.status.replace(original, signature) }));
  }
  scenario = { ...scenario, buyer };
  const history: StoreOrder[] = (scenario.history ?? []).map((h, i) => {
    const { daysAgo, amount, ...rest } = h;
    return {
      id: `ORD-${suffix}-H${i + 1}`,
      capture_id: `CAP-${suffix}-H${i + 1}`,
      buyer_name: scenario.buyer.name,
      buyer_email: scenario.buyer.email,
      placed_at: clock.ago(daysAgo),
      amount,
      currency: "USD",
      items: [{ name: "Earlier order", qty: 1, price: amount }],
      shipping_address: order.shipping_address,
      address_matches_account: true,
      shipment: {
        carrier: "UPS",
        tracking_number: `1Z999AA1${String(1000000000 + i).slice(1)}`,
        shipped_at: clock.ago(daysAgo - 1),
        delivered_at: clock.ago(daysAgo - 4),
        events: [{ at: clock.ago(daysAgo - 4), status: "Delivered" }],
      },
      messages: [],
      ...rest,
    };
  });
  const openedIso = new Date(opened).toISOString();
  const dispute: PayPalDispute = {
    dispute_id: `PP-D-${suffix}`,
    create_time: openedIso,
    update_time: openedIso,
    reason: scenario.reason,
    status: "WAITING_FOR_SELLER_RESPONSE",
    dispute_life_cycle_stage: scenario.reason === "UNAUTHORISED" ? "CHARGEBACK" : "INQUIRY",
    dispute_amount: { currency_code: "USD", value: scenario.amount.toFixed(2) },
    seller_response_due_date: new Date(opened + 10 * 86_400_000).toISOString(),
    disputed_transactions: [
      {
        seller_transaction_id: captureId,
        buyer: { name: scenario.buyer.name, email: scenario.buyer.email },
        custom: order.id,
      },
    ],
    messages: [{ posted_by: "BUYER", time_posted: openedIso, content: scenario.buyerClaim }],
  };
  return { order, history, dispute };
}
