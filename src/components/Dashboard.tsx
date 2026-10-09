"use client";

import type { GridApi } from "ag-grid-community";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GridQuery } from "@/lib/nlfilter";
import type { Settings } from "@/lib/types";
import DisputeDrawer from "./DisputeDrawer";
import { api, money, recovered, toGridRow, type DeskDispute, type DeskMode, type GridRow } from "./format";

const DisputeGrid = dynamic(() => import("./DisputeGrid"), { ssr: false });
const Charts = dynamic(() => import("./Charts"), { ssr: false });

interface Desk {
  /** Client clock at the moment this snapshot arrived; deadlines are measured from it. */
  loadedAt: number;
  disputes: DeskDispute[];
  settings: Settings;
  mode: DeskMode;
}

const NUMBER_FIELDS = new Set(["amount", "win_probability", "evidence_score", "due_in_hours"]);
const EXAMPLES = ["unauthorized claims over $100", "winnable cases due this week", "what should I refund?"];

export default function Dashboard() {
  const [desk, setDesk] = useState<Desk | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [selected, setSelected] = useState<GridRow[]>([]);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [scenarios, setScenarios] = useState<Array<{ key: string; title: string }>>([]);
  const [menu, setMenu] = useState<"simulate" | "autopilot" | "import" | null>(null);
  const [caseInput, setCaseInput] = useState("");
  const [query, setQuery] = useState("");
  const [queryNote, setQueryNote] = useState<string | null>(null);
  const [querying, setQuerying] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const gridApi = useRef<GridApi<GridRow> | null>(null);
  const lastJson = useRef("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/desk");
      const text = await res.text();
      if (!res.ok) throw new Error(JSON.parse(text).error ?? "Could not load disputes");
      // Skip the re-render when nothing changed, so the grid stays still between polls.
      if (text !== lastJson.current) {
        lastJson.current = text;
        setDesk({ ...JSON.parse(text), loadedAt: Date.now() });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const anyRunning = desk?.disputes.some((d) => d.agent_status === "queued" || d.agent_status === "running");
  useEffect(() => {
    const first = setTimeout(load, 0);
    const timer = setInterval(load, anyRunning ? 1000 : 4000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load, anyRunning]);

  useEffect(() => {
    api<{ scenarios: Array<{ key: string; title: string }> }>("/api/simulate").then((r) => setScenarios(r.scenarios)).catch(() => {});
  }, []);

  const rows = useMemo(() => (desk ? desk.disputes.map((d) => toGridRow(d, desk.loadedAt)) : []), [desk]);

  const stats = useMemo(() => {
    const all = desk?.disputes ?? [];
    const open = rows.filter((r) => !r.outcome && !r.decision);
    const contested = all.filter((d) => d.decision === "FIGHT" && (d.outcome === "WON" || d.outcome === "LOST"));
    return {
      needsResponse: open.length,
      atStake: open.reduce((sum, r) => sum + r.amount, 0),
      urgent: open.filter((r) => r.due_in_hours != null && r.due_in_hours < 48).length,
      recovered: all.reduce((sum, d) => sum + recovered(d), 0),
      winRate: contested.length ? Math.round((contested.filter((d) => d.outcome === "WON").length / contested.length) * 100) : null,
      contested: contested.length,
    };
  }, [desk, rows]);

  const openRow = rows.find((r) => r.id === openId) ?? null;

  const approve = useCallback(
    async (targets: GridRow[]) => {
      setBusy((b) => new Set([...b, ...targets.map((t) => t.id)]));
      for (const row of targets) {
        if (!row.verdict) continue;
        try {
          await api(`/api/disputes/${row.id}/decide`, { body: { action: row.verdict.recommendation } });
        } catch (e) {
          setError(`${row.id}: ${e instanceof Error ? e.message : e}`);
        }
      }
      setBusy((b) => {
        const next = new Set(b);
        targets.forEach((t) => next.delete(t.id));
        return next;
      });
      gridApi.current?.deselectAll();
      load();
    },
    [load],
  );
  const approveOne = useCallback((row: GridRow) => approve([row]), [approve]);

  const task = async (label: string, fn: () => Promise<unknown>) => {
    setWorking(label);
    setMenu(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(null);
    }
  };

  const applyQuery = async (text: string) => {
    if (!text.trim() || !gridApi.current) return;
    setQuerying(true);
    try {
      const q = await api<GridQuery & { engine: string }>("/api/nlfilter", { body: { query: text } });
      const model: Record<string, unknown> = {};
      for (const f of q.filters) {
        model[f.field] = NUMBER_FIELDS.has(f.field)
          ? { filterType: "number", type: f.op === "lessThan" ? "lessThan" : "greaterThan", filter: Number(f.value) }
          : { filterType: "text", type: f.op === "equals" ? "equals" : "contains", filter: f.value };
      }
      gridApi.current.setFilterModel(model);
      if (q.sort) {
        gridApi.current.applyColumnState({ state: [{ colId: q.sort.field, sort: q.sort.direction }], defaultState: { sort: null } });
      }
      setQueryNote(q.explanation);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setQuerying(false);
    }
  };

  const clearQuery = () => {
    gridApi.current?.setFilterModel(null);
    gridApi.current?.applyColumnState({ state: [{ colId: "due_in_hours", sort: "asc" }], defaultState: { sort: null } });
    setQuery("");
    setQueryNote(null);
  };

  const saveSettings = (patch: Partial<Settings>) =>
    desk && task("Saving", () => api("/api/settings", { method: "PUT", body: { ...desk.settings, ...patch } }));

  const mode = desk?.mode;
  const aiCapped = !!mode && mode.ai_usage.limit > 0 && mode.ai_usage.used >= mode.ai_usage.limit;
  const selectedTotal = selected.reduce((sum, r) => sum + r.amount, 0);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="topbar">
        <div className="flex items-center gap-3 min-w-0">
          <div className="logo" aria-hidden>
            D
          </div>
          <div className="min-w-0">
            <h1 className="font-semibold leading-tight">Dispute Desk</h1>
            <p className="text-xs text-muted leading-tight truncate">AI chargeback agent for PayPal merchants</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 justify-end">
          {mode && (
            <>
              <span className="chip" title={
                  mode.paypal === "live"
                    ? "Connected to the PayPal sandbox REST API. Rows tagged Sample are simulated."
                    : "No PayPal credentials set: every case is simulated"
                }>
                <span className={`chip-dot ${mode.paypal === "live" ? "bg-good" : "bg-warn"}`} />
                PayPal: {mode.paypal === "live" ? "sandbox" : "simulator"}
              </span>
              <span
                className="chip"
                title={
                  mode.ai !== "claude"
                    ? "No Anthropic API key set: using the deterministic rules engine"
                    : aiCapped
                      ? "Today's AI allowance is used up. New disputes are scored by the rules engine until midnight UTC."
                      : `Model ${mode.model}`
                }
              >
                <span className={`chip-dot ${mode.ai === "claude" && !aiCapped ? "bg-good" : "bg-warn"}`} />
                AI: {mode.ai !== "claude" ? "rules engine" : aiCapped ? "daily limit reached" : "Claude"}
                {mode.ai === "claude" && mode.ai_usage.limit > 0 && (
                  <span className="tabular-nums text-faint">
                    {mode.ai_usage.used}/{mode.ai_usage.limit}
                  </span>
                )}
              </span>
            </>
          )}
          <Link href="/store" className="btn btn-ghost btn-sm">
            Demo store
          </Link>
          <div className="relative">
            <button className="btn btn-ghost btn-sm" onClick={() => setMenu(menu === "autopilot" ? null : "autopilot")}>
              Autopilot {desk?.settings.autopilot ? "on" : "off"}
            </button>
            {menu === "autopilot" && desk && (
              <div className="popover w-80 p-4 text-sm">
                <label className="flex items-center justify-between font-medium">
                  Act without asking me
                  <input type="checkbox" checked={desk.settings.autopilot} onChange={(e) => saveSettings({ autopilot: e.target.checked })} />
                </label>
                <p className="text-xs text-muted mt-1 mb-3">Applies to disputes analysed from now on. Everything else waits for your approval.</p>
                <label className="flex items-center justify-between gap-2 py-1">
                  Refund unwinnable claims under
                  <span className="flex items-center gap-1">
                    $
                    <input
                      className="input w-16"
                      type="number"
                      min={0}
                      defaultValue={desk.settings.auto_refund_under}
                      onBlur={(e) => saveSettings({ auto_refund_under: Number(e.target.value) })}
                    />
                  </span>
                </label>
                <label className="flex items-center justify-between gap-2 py-1">
                  Contest when win chance is at least
                  <span className="flex items-center gap-1">
                    <input
                      className="input w-16"
                      type="number"
                      min={50}
                      max={100}
                      defaultValue={desk.settings.auto_fight_above}
                      onBlur={(e) => saveSettings({ auto_fight_above: Number(e.target.value) })}
                    />
                    %
                  </span>
                </label>
              </div>
            )}
          </div>
          {mode?.paypal === "live" && (
            <>
              <div className="relative">
                <button className="btn btn-ghost btn-sm" onClick={() => setMenu(menu === "import" ? null : "import")}>
                  Import case
                </button>
                {menu === "import" && (
                  <form
                    className="popover w-80 p-4 text-sm"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const caseId = caseInput.trim();
                      if (caseId) task("Syncing", () => api("/api/sync", { body: { caseId } })).then(() => setCaseInput(""));
                    }}
                  >
                    <label className="font-medium" htmlFor="case-id">
                      PayPal case ID
                    </label>
                    <p className="text-xs text-muted mt-1 mb-2">Use this when a new case has not shown up in Sync yet.</p>
                    <div className="flex gap-2">
                      <input
                        id="case-id"
                        className="input flex-1 font-mono"
                        placeholder="PP-R-..."
                        value={caseInput}
                        onChange={(e) => setCaseInput(e.target.value)}
                      />
                      <button className="btn btn-primary" disabled={!caseInput.trim()}>
                        Import
                      </button>
                    </div>
                  </form>
                )}
              </div>
              <button className="btn btn-ghost btn-sm" disabled={!!working} onClick={() => task("Syncing", () => api("/api/sync", { method: "POST" }))}>
                {working === "Syncing" ? "Syncing" : "Sync from PayPal"}
              </button>
            </>
          )}
          {mode?.sample_cases && (
            <div className="relative">
              <button className="btn btn-primary btn-sm" disabled={!!working} onClick={() => setMenu(menu === "simulate" ? null : "simulate")}>
                {working === "Simulating" ? "Opening case" : "Try a sample case"}
              </button>
              {menu === "simulate" && (
                <div className="popover w-96 py-1.5 text-sm max-h-[70vh] overflow-y-auto">
                  <p className="px-3.5 pt-1.5 pb-2 text-xs text-muted">
                    A simulated buyer opens a dispute. The agent analyses it like a real one; no PayPal login needed.
                  </p>
                  <button className="menu-item font-medium" onClick={() => task("Simulating", () => api("/api/simulate", { body: {} }))}>
                    Random case
                  </button>
                  {scenarios.map((s) => (
                    <button key={s.key} className="menu-item" onClick={() => task("Simulating", () => api("/api/simulate", { body: { scenario: s.key } }))}>
                      {s.title}
                    </button>
                  ))}
                  <div className="border-t border-line mt-1.5 pt-1.5">
                    <button
                      className="menu-item text-muted"
                      onClick={() => {
                        setOpenId(null);
                        task("Resetting", () => api("/api/reset", { method: "POST" }));
                      }}
                    >
                      Reset sample cases
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      {error && (
        <div className="mx-6 mt-4 flex items-start justify-between gap-4 rounded-lg border border-bad/30 bg-bad/5 px-4 py-2.5 text-sm text-bad-ink" role="alert">
          <span>{error}</span>
          <button className="font-medium" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <main className="flex-1 px-6 py-5 space-y-4 max-w-[1680px] w-full mx-auto">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Kpi label="Need your response" value={desk ? String(stats.needsResponse) : "-"} note={stats.urgent ? `${stats.urgent} due within 48 hours` : "None urgent"} tone={stats.urgent ? "bad" : undefined} />
          <Kpi label="Money at stake" value={desk ? money(stats.atStake) : "-"} note="Open disputes" />
          <Kpi label="Kept from resolved disputes" value={desk ? money(stats.recovered) : "-"} note="Won or settled" tone="good" />
          <Kpi label="Win rate when contested" value={stats.winRate == null ? "-" : `${stats.winRate}%`} note={`${stats.contested} contested cases closed`} />
        </div>

        <section className="card">
          <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-line">
            <form
              className="flex flex-1 min-w-72 items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                applyQuery(query);
              }}
            >
              <input
                className="input flex-1"
                placeholder="Ask for what you want to see, e.g. unauthorized claims over $100 due this week"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Describe the disputes to show"
              />
              <button className="btn btn-ghost" disabled={querying || !query.trim()}>
                {querying ? "Thinking" : "Filter"}
              </button>
              {queryNote && (
                <button type="button" className="btn btn-ghost" onClick={clearQuery}>
                  Clear
                </button>
              )}
            </form>
            {selected.length > 0 ? (
              <button className="btn btn-primary" onClick={() => approve(selected)}>
                Approve {selected.length} recommendation{selected.length > 1 ? "s" : ""} ({money(selectedTotal)})
              </button>
            ) : (
              !queryNote && (
                <div className="hidden xl:flex items-center gap-1.5 text-xs text-muted">
                  Try
                  {EXAMPLES.map((ex) => (
                    <button
                      key={ex}
                      className="chip hover:border-accent hover:text-accent"
                      onClick={() => {
                        setQuery(ex);
                        applyQuery(ex);
                      }}
                    >
                      {ex}
                    </button>
                  ))}
                </div>
              )
            )}
          </div>
          {queryNote && <div className="px-4 py-2 text-sm text-accent bg-accent-soft border-b border-line">{queryNote}</div>}
          <div className="h-[520px] grid-flush">
            {desk ? (
              <DisputeGrid
                rows={rows}
                busy={busy}
                onOpen={setOpenId}
                onApprove={approveOne}
                onSelection={setSelected}
                onReady={(a) => (gridApi.current = a)}
              />
            ) : (
              <div className="h-full grid place-items-center text-muted text-sm">Loading disputes</div>
            )}
          </div>
        </section>

        {desk && <Charts disputes={desk.disputes} now={desk.loadedAt} />}
      </main>

      {openRow && mode && (
        <>
          <div className="scrim" onClick={() => setOpenId(null)} />
          <DisputeDrawer row={openRow} mode={mode} onClose={() => setOpenId(null)} onChanged={load} onError={setError} />
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, note, tone }: { label: string; value: string; note: string; tone?: "good" | "bad" }) {
  return (
    <div className="card px-4 py-3.5">
      <div className="text-xs text-muted">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums mt-1 ${tone === "good" ? "text-good" : ""}`}>{value}</div>
      <div className={`text-xs mt-0.5 ${tone === "bad" ? "text-bad font-medium" : "text-muted"}`}>{note}</div>
    </div>
  );
}
