"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { REASON_LABELS, type AuditEntry, type DisputeRow, type Recommendation, type StoreOrder } from "@/lib/types";
import { DECISION_STATUS, OUTCOME_LABEL, REC_LABEL, api, dateTime, dueLabel, money, type DeskMode, type GridRow } from "./format";

interface Detail {
  dispute: DisputeRow;
  order: StoreOrder | null;
  audit: AuditEntry[];
}

const AUDIT_LABEL: Record<string, string> = {
  dispute_received: "Dispute received from PayPal",
  analysed: "Analysis finished",
  submitted_fight: "Evidence submitted to PayPal",
  submitted_refund: "Claim accepted, buyer refunded",
  submitted_offer: "Partial refund offered",
  sandbox_adjudicated: "Sandbox ruling forced",
  sandbox_evidence_requested: "Sandbox asked the seller for evidence",
  resolved: "PayPal closed the case",
  seeded_history: "Demo history record",
};

const ACTION_VERB: Record<Recommendation, string> = {
  FIGHT: "Submit evidence",
  REFUND: "Refund buyer",
  OFFER: "Send offer",
};

interface Props {
  row: GridRow;
  mode: DeskMode;
  onClose: () => void;
  onChanged: () => void;
  onError: (message: string) => void;
}

export default function DisputeDrawer({ row, mode, onClose, onChanged, onError }: Props) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [letter, setLetter] = useState("");
  const [offer, setOffer] = useState("");
  const [action, setAction] = useState<Recommendation>("FIGHT");
  const [sending, setSending] = useState(false);

  // Refetch whenever the row's state moves on (analysis finished, action sent, case closed).
  const stamp = `${row.id}|${row.agent_status}|${row.decision}|${row.outcome}|${row.status}|${row.updated_at}`;
  // The draft is only reset when the agent produces a new one, so a background refresh keeps the merchant's edits.
  const appliedDraft = useRef<string | null>(null);
  useEffect(() => {
    let live = true;
    api<Detail>(`/api/disputes/${row.id}`)
      .then((d) => {
        if (!live) return;
        setDetail(d);
        const v = d.dispute.verdict;
        const draftKey = v ? `${d.dispute.id}|${v.response_letter}` : null;
        if (v && draftKey !== appliedDraft.current) {
          appliedDraft.current = draftKey;
          setLetter(v.response_letter);
          setAction(v.recommendation);
          setOffer(v.offer_amount ? String(v.offer_amount) : "");
        }
      })
      .catch((e) => onError(e.message));
    return () => {
      live = false;
    };
  }, [stamp, row.id, onError]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = useCallback(
    async (path: string, body?: unknown) => {
      setSending(true);
      try {
        await api(`/api/disputes/${row.id}/${path}`, { method: "POST", body: body ?? {} });
        onChanged();
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
      } finally {
        setSending(false);
      }
    },
    [row.id, onChanged, onError],
  );

  // The AI draft only fits the action it was written for; other actions start from standard wording.
  const chooseAction = (next: Recommendation) => {
    setAction(next);
    const draft = row.verdict;
    if (!draft) return;
    const amount = money(row.amount, row.currency);
    setLetter(
      next === draft.recommendation
        ? draft.response_letter
        : next === "REFUND"
          ? `We have reviewed your case and are refunding ${amount} in full. We are sorry for the trouble.`
          : next === "OFFER"
            ? "We are sorry about the problem with your order. We would like to offer a partial refund so you can keep the item."
            : `We contest this claim for case ${row.id}. The supporting records are attached.`,
    );
  };

  const d = detail?.dispute.id === row.id ? detail.dispute : null;
  const v = d?.verdict ?? row.verdict;
  const order = detail?.dispute.id === row.id ? detail.order : null;
  const analysing = row.agent_status === "queued" || row.agent_status === "running";
  const open = !row.outcome && !row.decision;
  const awaitingRuling = !!row.decision && !row.outcome;
  const rulingSent = !!detail?.audit.some((a) => a.dispute_id === row.id && a.action === "sandbox_adjudicated");
  const letterChanged = !!v && letter.trim() !== v.response_letter.trim();

  return (
    <aside className="drawer" aria-label={`Dispute ${row.id}`}>
      <header className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 border-b border-line">
        <div className="min-w-0">
          <div className="text-xs font-mono text-muted">{row.id}</div>
          <h2 className="text-lg font-semibold mt-0.5">
            {REASON_LABELS[row.reason] ?? row.reason} &middot; {money(row.amount, row.currency)}
          </h2>
          <div className="text-sm text-muted mt-0.5">
            {row.buyer_name ?? "Unknown buyer"}
            {row.due_in_hours != null && <> &middot; respond in {dueLabel(row.due_in_hours)}</>}
            {row.outcome && <> &middot; {OUTCOME_LABEL[row.outcome]}</>}
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
          Close
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
        {analysing && (
          <div className="flex items-center gap-3 rounded-lg bg-accent-soft text-accent px-4 py-3 text-sm">
            <span className="spinner" />
            {row.agent_step ?? "Queued for analysis"}
          </div>
        )}

        {v && !analysing && (
          <section>
            <div className="flex items-center gap-4">
              <div className="text-4xl font-semibold tabular-nums leading-none">
                {v.win_probability}
                <span className="text-xl text-muted">%</span>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-muted">Chance of winning</div>
                <span className={`pill pill-${v.recommendation.toLowerCase()} mt-1`}>
                  Recommends: {REC_LABEL[v.recommendation].toLowerCase()}
                  {v.recommendation === "OFFER" && v.offer_amount ? ` ${money(v.offer_amount, row.currency)}` : ""}
                </span>
              </div>
            </div>
            <p className="mt-3 text-sm leading-relaxed">{v.reasoning}</p>
            <p className="mt-2 text-xs text-muted">
              {row.engine === "claude"
                ? `Analysed by Claude (${mode.model ?? "model"}) from the PayPal claim, order record and buyer history.`
                : mode.ai === "claude"
                  ? "Scored by the built-in rules engine, because the daily AI limit was reached or the model call failed. The audit trail says which."
                  : "Scored by the built-in rules engine. Add an Anthropic API key for full AI analysis."}
              {row.evidence_score != null && ` Evidence on file: ${row.evidence_score}% of what PayPal asks for.`}
            </p>
          </section>
        )}

        {v && !analysing && (v.evidence.length > 0 || v.risk_flags.length > 0 || v.missing_evidence.length > 0) && (
          <section className="space-y-3">
            {v.evidence.length > 0 && (
              <div>
                <h3 className="section-title">Evidence for you</h3>
                <ul className="space-y-2">
                  {v.evidence.map((e, i) => (
                    <li key={i} className="flex gap-2.5 text-sm">
                      <span className={`dot dot-${e.strength}`} title={e.strength} />
                      <span>
                        <span className="font-medium">{e.label}.</span> <span className="text-muted">{e.detail}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {v.risk_flags.length > 0 && (
              <div>
                <h3 className="section-title">Working against you</h3>
                <ul className="list-disc pl-5 text-sm space-y-1 text-bad-ink">
                  {v.risk_flags.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </div>
            )}
            {v.missing_evidence.length > 0 && (
              <div>
                <h3 className="section-title">Missing</h3>
                <ul className="list-disc pl-5 text-sm space-y-1 text-muted">
                  {v.missing_evidence.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        {v && open && !analysing && (
          <section>
            <h3 className="section-title">Your response</h3>
            <div className="seg mb-3" role="tablist">
              {(["FIGHT", "OFFER", "REFUND"] as const).map((a) => (
                <button key={a} role="tab" aria-selected={action === a} className={action === a ? "active" : ""} onClick={() => chooseAction(a)}>
                  {REC_LABEL[a]}
                  {v.recommendation === a && <span className="ml-1 text-[10px] opacity-70">AI pick</span>}
                </button>
              ))}
            </div>
            {action === "OFFER" && (
              <label className="flex items-center gap-2 text-sm mb-3">
                Partial refund
                <input className="input w-28" inputMode="decimal" value={offer} onChange={(e) => setOffer(e.target.value)} placeholder="0.00" />
                <span className="text-muted">of {money(row.amount, row.currency)}</span>
              </label>
            )}
            <textarea
              className="input w-full font-mono text-[12.5px] leading-relaxed"
              rows={action === "FIGHT" ? 12 : 4}
              value={letter}
              onChange={(e) => setLetter(e.target.value)}
              aria-label={action === "FIGHT" ? "Letter to PayPal" : "Note to buyer"}
            />
            {action !== v.recommendation && (
              <p className="text-xs text-muted mt-1.5">
                Standard wording, because the AI draft was written for &ldquo;{REC_LABEL[v.recommendation].toLowerCase()}&rdquo;. Edit
                it as you like.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <button
                className="btn btn-primary"
                disabled={sending}
                onClick={() =>
                  run("decide", {
                    action,
                    letter,
                    ...(action === "OFFER" ? { offerAmount: Number(offer) } : {}),
                  })
                }
              >
                {sending ? "Sending" : ACTION_VERB[action]}
              </button>
              {action === "FIGHT" && (
                <a
                  className="btn btn-ghost"
                  href={`/api/disputes/${row.id}/evidence`}
                  target="_blank"
                  rel="noreferrer"
                  title={letterChanged ? "Preview uses the AI draft; your edits are included when you submit." : undefined}
                >
                  Preview evidence PDF
                </a>
              )}
              <button className="btn btn-ghost" disabled={sending} onClick={() => run("analyze")}>
                Re-analyse
              </button>
            </div>
          </section>
        )}

        {!open && row.decision && (
          <section className="rounded-lg border border-line px-4 py-3 text-sm">
            <div className="font-medium">
              {DECISION_STATUS[row.decision]}
              {row.decided_by === "autopilot" ? " by autopilot" : ""}
              {row.submitted_at ? ` on ${dateTime(row.submitted_at)}` : ""}
            </div>
            {row.outcome ? (
              <div className="text-muted mt-0.5">Case closed: {OUTCOME_LABEL[row.outcome].toLowerCase()}.</div>
            ) : (
              <div className="text-muted mt-0.5">Waiting for {row.decision === "OFFER" ? "the buyer" : "PayPal"}.</div>
            )}
            {awaitingRuling && rulingSent && (
              <div className="mt-3 pt-3 border-t border-line text-xs text-muted">
                Ruling sent to PayPal. It takes a couple of minutes to close the case; this page updates on its own.
              </div>
            )}
            {awaitingRuling && !rulingSent && (
              <div className="mt-3 pt-3 border-t border-line">
                <div className="text-xs text-muted mb-2">
                  Sandbox test control. PayPal normally takes days to rule; this forces the ruling now
                  {mode.paypal === "live"
                    ? " through the sandbox adjudicate endpoint. PayPal accepts it 10 to 15 minutes after your response is filed, and takes a couple of minutes to close the case."
                    : " in the simulator."}
                </div>
                <div className="flex gap-2">
                  <button className="btn btn-ghost btn-sm" disabled={sending} onClick={() => run("adjudicate", { outcome: "SELLER_FAVOR" })}>
                    Rule for seller
                  </button>
                  <button className="btn btn-ghost btn-sm" disabled={sending} onClick={() => run("adjudicate", { outcome: "BUYER_FAVOR" })}>
                    {row.decision === "OFFER" ? "Buyer accepts offer" : "Rule for buyer"}
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {d?.raw.messages && d.raw.messages.length > 0 && (
          <section>
            <h3 className="section-title">Claim on PayPal</h3>
            <div className="space-y-2">
              {d.raw.messages.map((m, i) => (
                <div key={i} className={`bubble ${m.posted_by === "BUYER" ? "bubble-buyer" : "bubble-seller"}`}>
                  <div className="bubble-meta">
                    {m.posted_by === "BUYER" ? "Buyer" : "You"} &middot; {dateTime(m.time_posted)}
                  </div>
                  {m.content}
                </div>
              ))}
            </div>
          </section>
        )}

        {order && (
          <section>
            <h3 className="section-title">Order {order.id}</h3>
            <dl className="kv">
              <dt>Placed</dt>
              <dd>{dateTime(order.placed_at)}</dd>
              <dt>Items</dt>
              <dd>{order.items.map((i) => `${i.qty} x ${i.name}`).join(", ")}</dd>
              <dt>Ship to</dt>
              <dd>
                {order.shipping_address || "-"}
                {order.address_matches_account === false && <span className="text-bad"> (not the account address)</span>}
              </dd>
              {order.refunds && order.refunds.length > 0 && (
                <>
                  <dt>Refunds</dt>
                  <dd>{order.refunds.map((r) => `${r.id} ${money(r.amount, order.currency)}`).join(", ")}</dd>
                </>
              )}
              {order.internal_notes && (
                <>
                  <dt>Notes</dt>
                  <dd>{order.internal_notes}</dd>
                </>
              )}
            </dl>

            <h4 className="text-xs font-medium text-muted mt-4 mb-1.5">
              {order.shipment ? `${order.shipment.carrier} ${order.shipment.tracking_number}` : "No shipment tracking on file"}
            </h4>
            {order.shipment && (
              <ol className="timeline">
                {order.shipment.events.map((e, i) => (
                  <li key={i}>
                    <span className="text-muted tabular-nums">{dateTime(e.at)}</span> {e.status}
                    {e.location ? `, ${e.location}` : ""}
                  </li>
                ))}
              </ol>
            )}

            {order.messages && order.messages.length > 0 && (
              <div className="space-y-2 mt-4">
                {order.messages.map((m, i) => (
                  <div key={i} className={`bubble ${m.from === "buyer" ? "bubble-buyer" : "bubble-seller"}`}>
                    <div className="bubble-meta">
                      {m.from === "buyer" ? "Buyer" : "You"} &middot; {dateTime(m.at)}
                    </div>
                    {m.body}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {detail && detail.dispute.id === row.id && detail.audit.length > 0 && (
          <section>
            <h3 className="section-title">Audit trail</h3>
            <ol className="timeline">
              {detail.audit.map((a) => (
                <li key={a.id}>
                  <span className="text-muted tabular-nums">{dateTime(a.at)}</span> {AUDIT_LABEL[a.action] ?? a.action}
                  <span className="tag ml-1.5">{a.actor}</span>
                  {a.detail?.ai_daily_limit_reached === true && (
                    <div className="text-xs text-warn">Daily AI limit reached, rules engine used.</div>
                  )}
                  {typeof a.detail?.claude_error === "string" && (
                    <div className="text-xs text-warn">Claude call failed, rules engine used: {a.detail.claude_error}</div>
                  )}
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
    </aside>
  );
}
