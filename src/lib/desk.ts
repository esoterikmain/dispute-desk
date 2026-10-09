import { evidenceScore, gatherCase } from "./agent/casefile";
import { claudeVerdict, hasClaude } from "./agent/claude";
import { rulesVerdict } from "./agent/rules";
import { gatewayFor, paypal } from "./paypal";
import { evidencePdf } from "./pdf";
import {
  audit,
  getDispute,
  getOrder,
  getOrderByCapture,
  getSettings,
  insertDispute,
  listAudit,
  listDisputes,
  updateDispute,
} from "./repo";
import { takeAllowance } from "./usage";
import type {
  AuditEntry,
  DisputeRow,
  Engine,
  Outcome,
  PayPalDispute,
  Recommendation,
  StoreOrder,
  Verdict,
} from "./types";

// The dispute lifecycle: ingest from PayPal, analyse, act, record the outcome.

const now = () => new Date().toISOString();

function outcomeOf(doc: PayPalDispute, decision: Recommendation | null): Outcome | null {
  if (doc.status !== "RESOLVED") return null;
  switch (doc.dispute_outcome?.outcome_code) {
    case "RESOLVED_SELLER_FAVOUR":
    case "RESOLVED_WITH_PAYOUT":
    case "DENIED":
    case "CANCELED_BY_BUYER":
      return "WON";
    case "ACCEPTED":
      return "REFUNDED";
    case "RESOLVED_BUYER_FAVOUR":
      // A buyer accepting our partial-refund offer closes the case in their favour for that amount only.
      return decision === "OFFER" ? "SETTLED" : "LOST";
    default:
      return "LOST";
  }
}

/** Upsert one PayPal dispute document. New open disputes are queued for analysis. */
export async function ingestDispute(
  doc: PayPalDispute,
  source: string,
  origin: DisputeRow["source"],
): Promise<{ isNew: boolean }> {
  const existing = await getDispute(doc.dispute_id);
  const tx = doc.disputed_transactions?.[0];

  if (existing) {
    const outcome = outcomeOf(doc, existing.decision);
    const patch: Partial<DisputeRow> = { status: doc.status, updated_at: doc.update_time, raw: doc };
    if (outcome && !existing.outcome) {
      patch.outcome = outcome;
      patch.resolved_at = doc.update_time;
      await audit(doc.dispute_id, "paypal", "resolved", { outcome, outcome_code: doc.dispute_outcome?.outcome_code });
    }
    await updateDispute(doc.dispute_id, patch);
    return { isNew: false };
  }

  const order =
    (tx?.custom ? await getOrder(tx.custom) : null) ??
    (tx?.seller_transaction_id ? await getOrderByCapture(tx.seller_transaction_id) : null);
  const row = toRow(doc, order, origin);
  await insertDispute(row);
  await audit(doc.dispute_id, "paypal", "dispute_received", { source, reason: doc.reason, amount: doc.dispute_amount.value });
  if (!row.outcome) queueAnalysis(doc.dispute_id);
  return { isNew: true };
}

/** Map a PayPal dispute document to a fresh, unanalysed row. */
export function toRow(doc: PayPalDispute, order: StoreOrder | null, origin: DisputeRow["source"]): DisputeRow {
  const tx = doc.disputed_transactions?.[0];
  const outcome = outcomeOf(doc, null);
  return {
    id: doc.dispute_id,
    source: origin,
    status: doc.status,
    reason: doc.reason,
    stage: doc.dispute_life_cycle_stage ?? null,
    amount: Number(doc.dispute_amount.value),
    currency: doc.dispute_amount.currency_code,
    buyer_name: tx?.buyer?.name ?? order?.buyer_name ?? null,
    buyer_email: tx?.buyer?.email ?? order?.buyer_email ?? null,
    transaction_id: tx?.seller_transaction_id ?? null,
    order_id: order?.id ?? null,
    created_at: doc.create_time,
    updated_at: doc.update_time,
    response_due: doc.seller_response_due_date ?? null,
    outcome,
    resolved_at: outcome ? doc.update_time : null,
    agent_status: outcome ? "idle" : "queued",
    agent_step: null,
    engine: null,
    verdict: null,
    evidence_score: null,
    decision: null,
    decided_by: null,
    submitted_at: null,
    raw: doc,
  };
}

/** Pull every dispute from PayPal. The safety net behind webhooks. Sample cases never need it. */
export async function syncFromPayPal(caseId?: string): Promise<{ total: number; added: number }> {
  const gateway = paypal();
  const origin = gateway.mode === "live" ? "paypal" : "simulator";
  const summaries = await gateway.listDisputes();
  const seen = new Set<string>();
  let added = 0;
  for (const summary of summaries) {
    seen.add(summary.dispute_id);
    const existing = await getDispute(summary.dispute_id);
    if (existing && existing.updated_at === summary.update_time) continue;
    // The list endpoint returns summaries; buyer and transaction details need the full document.
    const full = gateway.mode === "live" ? await gateway.getDispute(summary.dispute_id) : summary;
    if ((await ingestDispute(full, "sync", origin)).isNew) added++;
  }
  if (gateway.mode === "live") {
    // The sandbox list endpoint has been seen to return nothing for a dispute that exists
    // and can be fetched by ID. So open cases we already know, and a case ID the merchant
    // types in, are fetched directly.
    const known = (await listDisputes())
      .filter((d) => d.source === "paypal" && !d.outcome && !seen.has(d.id))
      .map((d) => d.id);
    for (const id of new Set([...(caseId ? [caseId] : []), ...known])) {
      if ((await ingestDispute(await gateway.getDispute(id), caseId === id ? "import" : "sync", "paypal")).isNew) added++;
    }
  }
  return { total: summaries.length, added };
}

export async function refreshDispute(id: string): Promise<void> {
  const gateway = await gatewayFor(id);
  await ingestDispute(await gateway.getDispute(id), "refresh", gateway.mode === "live" ? "paypal" : "simulator");
}

// --- analysis queue -------------------------------------------------------------

const g = globalThis as unknown as { __deskQueue?: { active: Set<string>; pending: string[]; running: number } };
const queue = (g.__deskQueue ??= { active: new Set(), pending: [], running: 0 });
const CONCURRENCY = 3;

export function queueAnalysis(id: string): void {
  if (queue.active.has(id)) return;
  queue.active.add(id);
  queue.pending.push(id);
  pump();
}

function pump(): void {
  while (queue.running < CONCURRENCY && queue.pending.length > 0) {
    const id = queue.pending.shift()!;
    queue.running++;
    analyzeDispute(id)
      .catch((err) => console.error(`[desk] analysis of ${id} failed`, err))
      .finally(() => {
        queue.running--;
        queue.active.delete(id);
        pump();
      });
  }
}

/** Re-queue rows left in queued/running by a restart. */
export async function resumeStalled(rows: DisputeRow[]): Promise<void> {
  for (const row of rows) {
    if ((row.agent_status === "queued" || row.agent_status === "running") && !queue.active.has(row.id)) {
      queueAnalysis(row.id);
    }
  }
}

export async function analyzeDispute(id: string, opts: { engine?: Engine } = {}): Promise<Verdict> {
  const dispute = await getDispute(id);
  if (!dispute) throw new Error(`Dispute ${id} not found`);
  await updateDispute(id, { agent_status: "running", agent_step: "Gathering evidence" });

  const caseFile = await gatherCase(dispute);
  let engine: Engine = opts.engine ?? (hasClaude() ? "claude" : "rules");
  let verdict: Verdict;
  let fallbackNote: string | undefined;
  let limitReached = false;
  if (engine === "claude" && !(await takeAllowance("analysis"))) {
    engine = "rules";
    limitReached = true;
  }
  try {
    verdict =
      engine === "claude"
        ? await claudeVerdict(dispute, (step) => updateDispute(id, { agent_step: step }))
        : rulesVerdict(caseFile);
  } catch (err) {
    if (engine !== "claude") {
      await updateDispute(id, { agent_status: "error", agent_step: String(err) });
      throw err;
    }
    // Never leave a dispute unscored because the model call failed: fall back and say so.
    fallbackNote = err instanceof Error ? err.message : String(err);
    console.error(`[desk] Claude analysis of ${id} failed, using rules engine`, err);
    engine = "rules";
    verdict = rulesVerdict(caseFile);
  }

  await updateDispute(id, {
    agent_status: "done",
    agent_step: null,
    engine,
    verdict,
    evidence_score: evidenceScore(caseFile),
  });
  await audit(id, "agent", "analysed", {
    engine,
    recommendation: verdict.recommendation,
    win_probability: verdict.win_probability,
    ...(fallbackNote ? { claude_error: fallbackNote } : {}),
    ...(limitReached ? { ai_daily_limit_reached: true } : {}),
  });

  await maybeAutopilot(id, verdict);
  return verdict;
}

async function maybeAutopilot(id: string, verdict: Verdict): Promise<void> {
  const settings = await getSettings();
  if (!settings.autopilot) return;
  const dispute = await getDispute(id);
  if (!dispute || dispute.decision || dispute.outcome) return;
  const autoRefund = verdict.recommendation === "REFUND" && dispute.amount < settings.auto_refund_under;
  const autoFight = verdict.recommendation === "FIGHT" && verdict.win_probability >= settings.auto_fight_above;
  if (!autoRefund && !autoFight) return;
  await act(id, { action: verdict.recommendation, actor: "autopilot" });
}

// --- actions --------------------------------------------------------------------

const EVIDENCE_TYPE: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "PROOF_OF_FULFILLMENT",
  CREDIT_NOT_PROCESSED: "PROOF_OF_REFUND",
};

export interface ActInput {
  action: Recommendation;
  actor: AuditEntry["actor"];
  /** Merchant-edited text; defaults to the agent's draft. */
  letter?: string;
  offerAmount?: number;
}

/** Carry out a decision on PayPal and record it. */
export async function act(id: string, input: ActInput): Promise<void> {
  // The actions PayPal allows on a case change over time, so decide from a fresh copy.
  const gateway = await gatewayFor(id);
  if (gateway.mode === "live") await refreshDispute(id);
  const dispute = await getDispute(id);
  if (!dispute) throw new Error(`Dispute ${id} not found`);
  if (dispute.decision) throw new Error(`Dispute ${id} was already actioned (${dispute.decision})`);
  if (dispute.outcome) throw new Error(`Dispute ${id} is already resolved`);

  const letter = (input.letter ?? dispute.verdict?.response_letter ?? "").trim();
  if (gateway.mode === "live") {
    // PayPal lists the actions it will accept right now. Refuse early, in plain words.
    const allowed = new Set((dispute.raw.links ?? []).map((l) => l.rel));
    const needed = input.action === "REFUND" ? "accept_claim" : input.action === "OFFER" ? "make_offer" : null;
    if (needed && !allowed.has(needed)) {
      const what = input.action === "REFUND" ? "a refund" : "a partial-refund offer";
      throw new Error(
        `PayPal is not accepting ${what} on this case at its current stage (${dispute.raw.dispute_life_cycle_stage ?? dispute.status}). Nothing was sent. You can still submit evidence, or sync and try again later.`,
      );
    }
  }
  const order = dispute.order_id ? await getOrder(dispute.order_id) : null;
  const detail: Record<string, unknown> = { paypal_mode: gateway.mode };

  if (input.action === "FIGHT") {
    if (!letter) throw new Error("A response letter is required to contest a dispute");
    const pdf = await evidencePdf(dispute, order, letter);
    const allowed = new Set((dispute.raw.links ?? []).map((l) => l.rel));
    const supporting = allowed.has("provide_supporting_info") && !allowed.has("provide_evidence");
    if (gateway.mode === "live" && !supporting && !allowed.has("provide_evidence")) {
      // A sandbox claim sits "under review" until PayPal asks the seller for evidence. In
      // production PayPal makes that request itself; the sandbox has an endpoint to trigger it.
      await gateway.requireSellerEvidence(id);
      await audit(id, "system", "sandbox_evidence_requested");
    }
    await gateway.provideEvidence(id, {
      notes: letter,
      evidenceType: EVIDENCE_TYPE[dispute.reason] ?? "OTHER",
      tracking: order?.shipment ? { carrier: order.shipment.carrier, number: order.shipment.tracking_number } : undefined,
      pdf,
      as: supporting ? "supporting_info" : "evidence",
    });
    detail.filed_as = supporting ? "supporting_info" : "evidence";
    detail.evidence_pdf_bytes = pdf.length;
  } else if (input.action === "REFUND") {
    await gateway.acceptClaim(id, letter || "We are refunding this order in full.");
  } else {
    const amount = input.offerAmount ?? dispute.verdict?.offer_amount;
    if (!amount || amount <= 0 || amount >= dispute.amount) {
      throw new Error("A partial-refund offer needs an amount between zero and the disputed amount");
    }
    await gateway.makeOffer(id, { amount, currency: dispute.currency, note: letter || "We would like to offer a partial refund." });
    detail.offer_amount = amount;
    if (dispute.verdict && dispute.verdict.offer_amount !== amount) {
      await updateDispute(id, { verdict: { ...dispute.verdict, offer_amount: amount } });
    }
  }

  await updateDispute(id, { decision: input.action, decided_by: input.actor, submitted_at: now() });
  await audit(id, input.actor, `submitted_${input.action.toLowerCase()}`, detail);
  await refreshDispute(id);
}

/** Sandbox-only: make PayPal rule on a dispute now. */
export async function forceOutcome(id: string, outcome: "SELLER_FAVOR" | "BUYER_FAVOR"): Promise<void> {
  if ((await listAudit(id)).some((a) => a.action === "sandbox_adjudicated")) {
    throw new Error("A ruling was already sent for this case. PayPal takes a couple of minutes to close it.");
  }
  const gateway = await gatewayFor(id);
  try {
    await gateway.adjudicate(id, outcome);
  } catch (err) {
    if (err instanceof Error && err.message.includes("ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE")) {
      // Seen in testing: the sandbox enabled adjudicate 10 and 15 minutes after the seller's response was filed.
      throw new Error("PayPal is not accepting a sandbox ruling on this case yet. It becomes available 10 to 15 minutes after your response is filed.");
    }
    throw err;
  }
  await audit(id, "system", "sandbox_adjudicated", { outcome });
  await refreshDispute(id);
  if (gateway.mode === "live") {
    // PayPal closes the case a minute or two after accepting the ruling; pick that up without a manual sync.
    for (const delay of [45_000, 90_000, 150_000, 240_000]) {
      setTimeout(() => refreshDispute(id).catch((err) => console.error(`[desk] refresh of ${id} failed`, err)), delay);
    }
  }
}

export async function deskSnapshot(): Promise<DisputeRow[]> {
  const rows = await listDisputes();
  await resumeStalled(rows);
  return rows;
}
