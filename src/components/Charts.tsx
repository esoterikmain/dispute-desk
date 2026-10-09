"use client";

import { AllCommunityModule, ModuleRegistry, type AgChartOptions } from "ag-charts-community";
import { AgCharts } from "ag-charts-react";
import { useMemo } from "react";
import { REASON_LABELS } from "@/lib/types";
import { recovered, shortDate, type DeskDispute } from "./format";

ModuleRegistry.registerModules([AllCommunityModule]);

const WEEK = 7 * 86_400_000;
const COLORS = { kept: "#0e9f6e", given: "#f0a8a0", won: "#0e9f6e", settled: "#7c93f0", refunded: "#c4c9d4", lost: "#d92d20" };

const base = {
  background: { visible: false },
  padding: { top: 8, right: 8, bottom: 0, left: 0 },
  legend: { position: "bottom", item: { label: { fontSize: 12, color: "#667085" }, marker: { size: 8 } } },
} as const;

const axisLabel = { fontSize: 11, color: "#667085" };

export default function Charts({ disputes, now }: { disputes: DeskDispute[]; now: number }) {
  const { weekly, byReason } = useMemo(() => {
    const resolved = disputes.filter((d) => d.outcome && d.resolved_at);
    const weeks = Array.from({ length: 8 }, (_, i) => {
      const start = now - (8 - i) * WEEK;
      return { week: shortDate(new Date(start + WEEK).toISOString()), start, kept: 0, given: 0 };
    });
    for (const d of resolved) {
      const bucket = weeks.find((w) => Date.parse(d.resolved_at!) >= w.start && Date.parse(d.resolved_at!) < w.start + WEEK);
      if (!bucket) continue;
      const kept = recovered(d);
      bucket.kept += kept;
      bucket.given += d.amount - kept;
    }
    const reasons = new Map<string, { reason: string; won: number; settled: number; refunded: number; lost: number }>();
    for (const d of resolved) {
      const label = REASON_LABELS[d.reason] ?? d.reason;
      const row = reasons.get(label) ?? { reason: label, won: 0, settled: 0, refunded: 0, lost: 0 };
      row[d.outcome!.toLowerCase() as "won" | "settled" | "refunded" | "lost"]++;
      reasons.set(label, row);
    }
    return { weekly: weeks, byReason: [...reasons.values()] };
  }, [disputes, now]);

  const money: AgChartOptions = {
    ...base,
    data: weekly,
    series: [
      { type: "bar", xKey: "week", yKey: "kept", yName: "Kept", stacked: true, fill: COLORS.kept, cornerRadius: 3 },
      { type: "bar", xKey: "week", yKey: "given", yName: "Refunded or lost", stacked: true, fill: COLORS.given, cornerRadius: 3 },
    ],
    axes: {
      x: { type: "category", label: axisLabel, line: { enabled: false } },
      y: { type: "number", label: { ...axisLabel, formatter: (p) => `$${p.value}` }, gridLine: { style: [{ stroke: "#eef0f3" }] } },
    },
  };

  const outcomes: AgChartOptions = {
    ...base,
    data: byReason,
    series: (["won", "settled", "refunded", "lost"] as const).map((key) => ({
      type: "bar",
      direction: "horizontal",
      xKey: "reason",
      yKey: key,
      yName: key[0].toUpperCase() + key.slice(1),
      stacked: true,
      fill: COLORS[key],
    })),
    axes: {
      y: { type: "category", label: axisLabel, line: { enabled: false } },
      x: { type: "number", label: axisLabel, interval: { step: 1 }, gridLine: { style: [{ stroke: "#eef0f3" }] } },
    },
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="card p-4">
        <h2 className="card-title">Disputed money by week resolved</h2>
        <div className="h-56">
          <AgCharts options={money} style={{ height: "100%" }} />
        </div>
      </section>
      <section className="card p-4">
        <h2 className="card-title">Outcomes by claim type</h2>
        <div className="h-56">
          <AgCharts options={outcomes} style={{ height: "100%" }} />
        </div>
      </section>
    </div>
  );
}
