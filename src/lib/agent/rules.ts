import { REASON_LABELS, type EvidenceItem, type Recommendation, type Verdict } from "../types";
import type { CaseFile } from "./casefile";

// Deterministic scoring, used when no Claude credentials are configured and as the
// baseline the eval compares the model against. It reads structured fields and a few
// keywords; it cannot weigh free-text nuance the way the model does.

const REMORSE = /changed my mind|found (it|one|a) cheaper|no longer (want|need)|don'?t (want|need) it/i;
const MATCHES_LISTING = /(exactly|just) (like|as) (the )?(photos?|pictures?|described|listing)|as described/i;
const ADMITS_FAULT = /you'?re right|our (mistake|error|fault)|wrong (colou?r|item|size|variant)|we sent the wrong|pick error/i;
const WANTS_PARTIAL = /knock something off|partial refund|discount|rather keep it|keep it (and|if)/i;
const BUYER_CONFIRMS_RECEIPT = /arrived|received|got (it|the)/i;

const fmtDate = (iso?: string) => (iso ? new Date(iso).toISOString().slice(0, 10) : "unknown date");
const money = (n: number, c: string) => `${c === "USD" ? "$" : `${c} `}${n.toFixed(2)}`;

export function decide(p: number, amount: number, opts: { offerViable?: boolean } = {}): Recommendation {
  if (p >= 60) return "FIGHT";
  if (opts.offerViable && amount >= 100 && p >= 25) return "OFFER";
  return "REFUND";
}

export function rulesVerdict(c: CaseFile): Verdict {
  const { dispute: d, order: o } = c;
  const evidence: EvidenceItem[] = [];
  const missing: string[] = [];
  const flags: string[] = [];
  let p = 35;
  let offerViable = false;

  if (!o) {
    return {
      win_probability: 5,
      recommendation: "REFUND",
      offer_amount: null,
      summary: "No matching order record was found, so there is nothing to defend the claim with.",
      reasoning: `Transaction ${d.transaction_id ?? "(unknown)"} does not match any order in the store records.`,
      evidence: [],
      missing_evidence: ["Order record for the disputed transaction"],
      risk_flags: [],
      response_letter: "",
    };
  }

  const s = o.shipment;
  const buyerMsgs = (o.messages ?? []).filter((m) => m.from === "buyer");
  const merchantMsgs = (o.messages ?? []).filter((m) => m.from === "merchant");
  const buyerText = buyerMsgs.map((m) => m.body).join("\n");
  const merchantText = merchantMsgs.map((m) => m.body).join("\n") + "\n" + (o.internal_notes ?? "");

  if (s?.delivered_at) {
    evidence.push({
      label: "Carrier confirms delivery",
      detail: `${s.carrier} ${s.tracking_number} delivered ${fmtDate(s.delivered_at)}${s.signed_by ? `, signed by ${s.signed_by}` : ""}.`,
      strength: s.signed_by ? "strong" : "moderate",
    });
  }
  if (o.address_matches_account) {
    evidence.push({ label: "Shipped to account address", detail: o.shipping_address, strength: "moderate" });
  }

  switch (d.reason) {
    case "MERCHANDISE_OR_SERVICE_NOT_RECEIVED": {
      if (!s) {
        p = 5;
        missing.push("Tracking number or any proof of shipment");
      } else if (s.delivered_at) {
        p = s.signed_by ? 90 : 75;
        if (!o.address_matches_account) p -= 30;
      } else {
        p = 12;
        missing.push("Delivery confirmation (tracking shows the parcel has not arrived)");
      }
      break;
    }
    case "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED": {
      p = 40;
      if (ADMITS_FAULT.test(merchantText)) {
        p = 5;
        flags.push("Merchant records acknowledge an error with this order");
      } else if (REMORSE.test(buyerText) || MATCHES_LISTING.test(buyerText)) {
        p = 80;
        const quote = buyerMsgs.find((m) => REMORSE.test(m.body) || MATCHES_LISTING.test(m.body));
        if (quote) evidence.push({ label: "Buyer's own message", detail: `"${quote.body}"`, strength: "strong" });
      } else if (WANTS_PARTIAL.test(buyerText)) {
        p = 35;
        offerViable = true;
      } else {
        missing.push("Photos or listing details showing the item matched its description");
      }
      break;
    }
    case "UNAUTHORISED": {
      const prior = c.buyer_history.other_orders.filter((x) => x.shipping_address === o.shipping_address && x.delivered);
      p = 30;
      if (o.address_matches_account) p += 20;
      if (o.risk?.avs_match) p += 10;
      if (prior.length > 0) {
        p += 15;
        evidence.push({
          label: "Earlier undisputed orders to the same address",
          detail: `${prior.length} previous delivered order(s) to ${o.shipping_address}.`,
          strength: "strong",
        });
      }
      const after = s?.delivered_at ? buyerMsgs.find((m) => m.at >= s.delivered_at! && BUYER_CONFIRMS_RECEIPT.test(m.body)) : null;
      if (after) {
        p += 15;
        evidence.push({ label: "Buyer messaged about the order after delivery", detail: `"${after.body}"`, strength: "strong" });
      }
      if (o.address_matches_account === false) {
        p = Math.min(p, 10);
        flags.push("Shipped to an address that is not on the buyer's PayPal account");
      }
      if ((o.risk?.account_age_days ?? 999) < 14) flags.push("Buyer account is less than two weeks old");
      if (o.risk?.avs_match === false) flags.push("Address verification failed");
      break;
    }
    case "DUPLICATE_TRANSACTION": {
      const twin = c.buyer_history.other_orders.find(
        (x) => x.amount === o.amount && Math.abs(Date.parse(x.placed_at) - Date.parse(o.placed_at)) < 15 * 60_000,
      );
      if (twin && !s) {
        p = 5;
        flags.push(`Order ${twin.id} was captured for the same amount minutes earlier and only one parcel shipped`);
      } else if (c.buyer_history.other_orders.length > 0 && s?.delivered_at) {
        p = 85;
        evidence.push({
          label: "Two distinct orders",
          detail: `This order (${o.items.map((i) => i.name).join(", ")}, ${money(o.amount, o.currency)}) is separate from the buyer's other order(s) and was delivered on its own tracking number.`,
          strength: "strong",
        });
      } else {
        p = 40;
        missing.push("Proof that each charge corresponds to a separate fulfilled order");
      }
      break;
    }
    case "CREDIT_NOT_PROCESSED": {
      const refunded = (o.refunds ?? []).reduce((sum, r) => sum + r.amount, 0);
      if (refunded >= d.amount) {
        p = 90;
        evidence.push({
          label: "Refund already issued",
          detail: (o.refunds ?? []).map((r) => `${r.id}: ${money(r.amount, o.currency)} on ${fmtDate(r.at)}`).join("; "),
          strength: "strong",
        });
      } else if (o.return_received_at) {
        p = 5;
        flags.push(`Return was received on ${fmtDate(o.return_received_at)} and no refund has been issued`);
      } else {
        p = 55;
        missing.push("Return tracking showing whether the item came back");
      }
      break;
    }
    default:
      missing.push("This dispute type is not covered by the rules engine; review manually");
  }

  if (c.buyer_history.prior_disputes.length >= 2) {
    flags.push(`Buyer has opened ${c.buyer_history.prior_disputes.length} earlier disputes with this store`);
  }

  p = Math.max(1, Math.min(99, Math.round(p)));
  const recommendation = decide(p, d.amount, { offerViable });
  const offerAmount = recommendation === "OFFER" ? Math.round(d.amount * 0.2 * 100) / 100 : null;
  const label = REASON_LABELS[d.reason] ?? d.reason;

  const summary =
    recommendation === "FIGHT"
      ? `Strong evidence against this "${label}" claim.`
      : recommendation === "OFFER"
        ? `Partly valid claim; a ${money(offerAmount!, d.currency)} partial refund is cheaper than losing or paying return freight.`
        : `Evidence does not support contesting this "${label}" claim.`;

  return {
    win_probability: p,
    recommendation,
    offer_amount: offerAmount,
    summary,
    reasoning: [
      `Claim type: ${label}. Amount: ${money(d.amount, d.currency)}.`,
      evidence.length ? `Supporting evidence: ${evidence.map((e) => e.label).join("; ")}.` : "No supporting evidence found.",
      flags.length ? `Concerns: ${flags.join("; ")}.` : "",
      missing.length ? `Missing: ${missing.join("; ")}.` : "",
    ]
      .filter(Boolean)
      .join(" "),
    evidence,
    missing_evidence: missing,
    risk_flags: flags,
    response_letter: letter(c, recommendation, evidence, offerAmount),
  };
}

function letter(c: CaseFile, rec: Recommendation, evidence: EvidenceItem[], offer: number | null): string {
  const { dispute: d, order: o } = c;
  if (!o) return "";
  if (rec === "REFUND") {
    return `We have reviewed case ${d.id} and are issuing a full refund of ${money(d.amount, d.currency)}. We apologise for the inconvenience.`;
  }
  if (rec === "OFFER") {
    return `We are sorry the order did not arrive in perfect condition. We would like to offer a partial refund of ${money(offer!, d.currency)} so you can keep the item without the trouble of returning it.`;
  }
  return [
    `Re: PayPal case ${d.id}, transaction ${d.transaction_id ?? o.capture_id}`,
    "",
    `We respectfully contest this claim. Order ${o.id} was placed on ${fmtDate(o.placed_at)} for ${o.items
      .map((i) => `${i.qty} x ${i.name}`)
      .join(", ")}, totalling ${money(o.amount, o.currency)}.`,
    "",
    ...evidence.map((e, i) => `${i + 1}. ${e.label}: ${e.detail}`),
    "",
    "The supporting documents are attached. We ask that this case be resolved in the seller's favour.",
  ].join("\n");
}
