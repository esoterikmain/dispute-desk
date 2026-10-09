"use client";

import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type GridApi,
  type ICellRendererParams,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useMemo } from "react";
import { dueLabel, money, type GridRow } from "./format";

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  fontFamily: "inherit",
  fontSize: 13,
  accentColor: "#2f4bd8",
  borderColor: "#e4e7ec",
  headerBackgroundColor: "#fafbfc",
  headerTextColor: "#667085",
  headerFontWeight: 600,
  rowHoverColor: "#f5f7ff",
  selectedRowBackgroundColor: "#eef1ff",
  wrapperBorderRadius: 12,
  cellHorizontalPadding: 14,
});

type Cell<V = unknown> = ICellRendererParams<GridRow, V>;

const winColor = (p: number) => (p >= 60 ? "#0e9f6e" : p >= 30 ? "#c77700" : "#d92d20");

function CaseCell({ data }: Cell) {
  if (!data) return null;
  return (
    <div className="flex flex-col justify-center leading-tight h-full">
      <span className="font-medium text-ink truncate">{data.buyer_name ?? "Unknown buyer"}</span>
      <span className="flex items-center gap-1.5 min-w-0">
        <span className="font-mono text-[11px] text-muted truncate">{data.id}</span>
        {data.source === "simulator" && (
          <span className="tag" title="Simulated case, not a real PayPal dispute">
            Sample
          </span>
        )}
      </span>
    </div>
  );
}

function DueCell({ data }: Cell) {
  if (!data) return null;
  const h = data.due_in_hours;
  if (h == null) return <span className="text-faint">&ndash;</span>;
  const tone = h < 48 ? "text-bad font-semibold" : h < 120 ? "text-warn font-medium" : "text-ink";
  return <span className={`tabular-nums ${tone}`}>{dueLabel(h)}</span>;
}

function WinCell({ data }: Cell) {
  if (!data) return null;
  if (data.agent_status === "queued" || data.agent_status === "running") {
    return (
      <span className="flex items-center gap-2 h-full text-accent text-xs">
        <span className="spinner" />
        <span className="truncate">{data.agent_step ?? "Queued for analysis"}</span>
      </span>
    );
  }
  if (data.agent_status === "error") return <span className="text-bad text-xs">Analysis failed</span>;
  const p = data.win_probability;
  if (p == null) return <span className="text-faint">&ndash;</span>;
  return (
    <span className="flex items-center gap-2.5 h-full">
      <span className="w-9 tabular-nums font-semibold" style={{ color: winColor(p) }}>
        {p}%
      </span>
      <span className="meter flex-1">
        <span style={{ width: `${p}%`, background: winColor(p) }} />
      </span>
    </span>
  );
}

function RecCell({ data }: Cell) {
  if (!data?.verdict) return <span className="text-faint">&ndash;</span>;
  const rec = data.verdict.recommendation;
  return (
    <span className={`pill pill-${rec.toLowerCase()}`}>
      {data.recommendation_label}
      {rec === "OFFER" && data.verdict.offer_amount ? ` ${money(data.verdict.offer_amount, data.currency)}` : ""}
    </span>
  );
}

function EvidenceCell({ data }: Cell) {
  if (data?.evidence_score == null) return <span className="text-faint">&ndash;</span>;
  return (
    <span className="flex items-center gap-2 h-full">
      <span className="meter w-12">
        <span style={{ width: `${data.evidence_score}%`, background: "#667085" }} />
      </span>
      <span className="tabular-nums text-muted text-xs">{data.evidence_score}%</span>
    </span>
  );
}

function StatusCell({ data }: Cell) {
  if (!data) return null;
  if (data.outcome) return <span className={`pill pill-${data.outcome.toLowerCase()}`}>{data.outcome_label}</span>;
  return (
    <span className="flex items-center gap-1.5 h-full text-muted">
      {data.decided_by === "autopilot" && <span className="tag">Auto</span>}
      <span className="truncate">{data.status_label}</span>
    </span>
  );
}

interface Props {
  rows: GridRow[];
  busy: Set<string>;
  onOpen: (id: string) => void;
  onApprove: (row: GridRow) => void;
  onSelection: (rows: GridRow[]) => void;
  onReady: (api: GridApi<GridRow>) => void;
}

export default function DisputeGrid({ rows, busy, onOpen, onApprove, onSelection, onReady }: Props) {
  const columns = useMemo<ColDef<GridRow>[]>(
    () => [
      {
        colId: "buyer_name",
        headerName: "Buyer / case",
        valueGetter: (p) => p.data?.buyer_name,
        cellRenderer: CaseCell,
        filter: "agTextColumnFilter",
        minWidth: 150,
        flex: 1,
      },
      { colId: "reason", headerName: "Claim", field: "reason_label", filter: "agTextColumnFilter", width: 138 },
      {
        colId: "amount",
        headerName: "Amount",
        field: "amount",
        filter: "agNumberColumnFilter",
        type: "rightAligned",
        width: 100,
        valueFormatter: (p) => (p.data ? money(p.value, p.data.currency) : ""),
        cellClass: "tabular-nums font-medium",
      },
      {
        colId: "due_in_hours",
        headerName: "Respond in",
        field: "due_in_hours",
        filter: "agNumberColumnFilter",
        cellRenderer: DueCell,
        width: 112,
        // Resolved rows have no deadline; keep them below the open ones either way.
        comparator: (a, b, _na, _nb, desc) => (a ?? (desc ? -1e9 : 1e9)) - (b ?? (desc ? -1e9 : 1e9)),
      },
      {
        colId: "win_probability",
        headerName: "Win chance",
        field: "win_probability",
        filter: "agNumberColumnFilter",
        cellRenderer: WinCell,
        width: 150,
        enableCellChangeFlash: true,
      },
      {
        colId: "recommendation",
        headerName: "AI recommends",
        field: "recommendation_label",
        filter: "agTextColumnFilter",
        cellRenderer: RecCell,
        width: 132,
      },
      {
        colId: "evidence_score",
        headerName: "Evidence",
        field: "evidence_score",
        filter: "agNumberColumnFilter",
        cellRenderer: EvidenceCell,
        width: 108,
      },
      {
        colId: "summary",
        headerName: "Why",
        field: "summary",
        sortable: false,
        flex: 2,
        minWidth: 160,
        tooltipField: "summary",
        cellClass: "text-muted",
      },
      {
        colId: "status",
        headerName: "Status",
        field: "status_label",
        filter: "agTextColumnFilter",
        cellRenderer: StatusCell,
        width: 145,
      },
      { colId: "outcome", headerName: "Outcome", field: "outcome_label", filter: "agTextColumnFilter", hide: true },
      {
        colId: "action",
        headerName: "",
        sortable: false,
        width: 124,
        pinned: "right",
        cellRenderer: ({ data }: Cell) => {
          if (!data?.actionable || !data.verdict) return null;
          const pending = busy.has(data.id);
          return (
            <button
              className="btn btn-primary btn-sm"
              disabled={pending}
              onClick={(e) => {
                e.stopPropagation();
                onApprove(data);
              }}
            >
              {pending ? "Sending" : `Approve ${data.recommendation_label?.toLowerCase()}`}
            </button>
          );
        },
      },
    ],
    [busy, onApprove],
  );

  return (
    <AgGridReact<GridRow>
      theme={theme}
      rowData={rows}
      columnDefs={columns}
      getRowId={(p) => p.data.id}
      rowHeight={50}
      headerHeight={40}
      rowSelection={{ mode: "multiRow", isRowSelectable: (node) => !!node.data?.actionable }}
      selectionColumnDef={{ pinned: "left", width: 46 }}
      suppressCellFocus
      tooltipShowDelay={400}
      rowClass="cursor-pointer"
      onRowClicked={(e) => e.data && onOpen(e.data.id)}
      onSelectionChanged={(e) => onSelection(e.api.getSelectedRows())}
      onGridReady={(e) => {
        e.api.applyColumnState({ state: [{ colId: "due_in_hours", sort: "asc" }] });
        onReady(e.api);
      }}
      overlayNoRowsTemplate="No disputes match."
    />
  );
}
