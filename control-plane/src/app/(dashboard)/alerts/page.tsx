"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import {
  Bell, AlertTriangle, RefreshCw, CheckCircle,
  Loader2, RotateCcw, Save, ShieldAlert,
} from "lucide-react";
import clsx from "clsx";

// ── Types ──────────────────────────────────────────────────────────

type AlertLevel = "ok" | "warning" | "critical";
type AlertDirection = "above" | "below";

interface ThresholdWithStatus {
  id: string;
  name: string;
  description: string;
  metric_key: string;
  warning: number;
  critical: number;
  unit: string;
  direction: AlertDirection;
  enabled: boolean;
  current_value: number | null;
  alert_level: AlertLevel;
}

interface AlertsResponse {
  thresholds: ThresholdWithStatus[];
  summary: { ok: number; warning: number; critical: number };
  fetched_at: string;
}

// ── Helpers ────────────────────────────────────────────────────────

function levelColor(level: AlertLevel): string {
  return level === "critical"
    ? "text-red-400"
    : level === "warning"
    ? "text-amber-400"
    : "text-vault-green";
}

function levelBgBorder(level: AlertLevel): string {
  return level === "critical"
    ? "bg-red-500/10 border-red-500/20"
    : level === "warning"
    ? "bg-amber-500/10 border-amber-500/20"
    : "bg-emerald-500/10 border-emerald-500/20";
}

function AlertDot({ level }: { level: AlertLevel }) {
  return (
    <span
      className={clsx(
        "inline-block w-2 h-2 rounded-full shrink-0",
        level === "critical"
          ? "bg-red-400"
          : level === "warning"
          ? "bg-amber-400"
          : "bg-emerald-400",
      )}
    />
  );
}

function formatValue(val: number | null, unit: string): string {
  if (val === null) return "—";
  const formatted = Number.isInteger(val) ? val.toString() : val.toFixed(1);
  return unit ? `${formatted}${unit}` : formatted;
}

// ── Row component ──────────────────────────────────────────────────

interface RowState {
  warning: string;
  critical: string;
  enabled: boolean;
  saving: boolean;
  saved: boolean;
  error: string | null;
}

function ThresholdRow({
  threshold,
  canEdit,
  onSave,
}: {
  threshold: ThresholdWithStatus;
  canEdit: boolean;
  onSave: (
    id: string,
    patch: { warning?: number; critical?: number; enabled?: boolean },
  ) => Promise<boolean>;
}) {
  const [row, setRow] = useState<RowState>({
    warning:  String(threshold.warning),
    critical: String(threshold.critical),
    enabled:  threshold.enabled,
    saving:   false,
    saved:    false,
    error:    null,
  });

  // Sync when parent data refreshes (only if not currently editing — detect by comparing to threshold)
  useEffect(() => {
    setRow((prev) => ({
      ...prev,
      warning:  String(threshold.warning),
      critical: String(threshold.critical),
      enabled:  threshold.enabled,
    }));
  }, [threshold.warning, threshold.critical, threshold.enabled]);

  const isDirty =
    row.warning  !== String(threshold.warning)  ||
    row.critical !== String(threshold.critical) ||
    row.enabled  !== threshold.enabled;

  const handleSave = async () => {
    const warnNum = parseFloat(row.warning);
    const critNum = parseFloat(row.critical);
    if (isNaN(warnNum) || isNaN(critNum)) {
      setRow((r) => ({ ...r, error: "Warning and critical must be valid numbers." }));
      return;
    }
    setRow((r) => ({ ...r, saving: true, error: null }));
    const ok = await onSave(threshold.id, {
      warning: warnNum,
      critical: critNum,
      enabled: row.enabled,
    });
    if (ok) {
      setRow((r) => ({ ...r, saving: false, saved: true, error: null }));
      setTimeout(() => setRow((r) => ({ ...r, saved: false })), 2_000);
    } else {
      setRow((r) => ({ ...r, saving: false, error: "Save failed — check permissions." }));
    }
  };

  const level = threshold.alert_level;

  return (
    <tr className="hover:bg-slate-800/30 transition-colors align-top">
      {/* Name + description */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <AlertDot level={level} />
          <div>
            <p className="text-sm font-medium text-white">{threshold.name}</p>
            <p className="text-xs text-slate-500 mt-0.5">{threshold.description}</p>
          </div>
        </div>
      </td>

      {/* Current value */}
      <td className="px-4 py-3">
        <span
          className={clsx(
            "font-mono text-sm font-semibold",
            levelColor(level),
          )}
        >
          {formatValue(threshold.current_value, threshold.unit)}
        </span>
        <div className="flex items-center gap-1 mt-1">
          <span
            className={clsx(
              "text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide border",
              levelBgBorder(level),
              levelColor(level),
            )}
          >
            {level}
          </span>
        </div>
      </td>

      {/* Direction */}
      <td className="px-4 py-3 text-center">
        <span
          className="text-slate-400 text-base"
          title={threshold.direction === "above" ? "Fires when above threshold" : "Fires when below threshold"}
        >
          {threshold.direction === "above" ? "↑" : "↓"}
        </span>
        <p className="text-[10px] text-slate-600 mt-0.5">{threshold.direction}</p>
      </td>

      {/* Warning input */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            value={row.warning}
            onChange={(e) => setRow((r) => ({ ...r, warning: e.target.value }))}
            disabled={!canEdit}
            className={clsx(
              "w-20 px-2 py-1.5 bg-slate-900 border rounded text-amber-300 text-xs font-mono",
              "focus:outline-none focus:ring-1 focus:ring-amber-500/50 disabled:opacity-50",
              row.warning !== String(threshold.warning)
                ? "border-amber-500/50"
                : "border-slate-600",
            )}
          />
          {threshold.unit && (
            <span className="text-xs text-slate-500">{threshold.unit}</span>
          )}
        </div>
      </td>

      {/* Critical input */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            value={row.critical}
            onChange={(e) => setRow((r) => ({ ...r, critical: e.target.value }))}
            disabled={!canEdit}
            className={clsx(
              "w-20 px-2 py-1.5 bg-slate-900 border rounded text-red-300 text-xs font-mono",
              "focus:outline-none focus:ring-1 focus:ring-red-500/50 disabled:opacity-50",
              row.critical !== String(threshold.critical)
                ? "border-red-500/50"
                : "border-slate-600",
            )}
          />
          {threshold.unit && (
            <span className="text-xs text-slate-500">{threshold.unit}</span>
          )}
        </div>
      </td>

      {/* Enable toggle */}
      <td className="px-4 py-3">
        <button
          onClick={() => canEdit && setRow((r) => ({ ...r, enabled: !r.enabled }))}
          disabled={!canEdit}
          className={clsx(
            "relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50",
            row.enabled ? "bg-emerald-500/70" : "bg-slate-600",
          )}
          title={row.enabled ? "Enabled — click to disable" : "Disabled — click to enable"}
        >
          <span
            className={clsx(
              "inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform",
              row.enabled ? "translate-x-4" : "translate-x-0.5",
            )}
          />
        </button>
        <p className="text-[10px] text-slate-600 mt-0.5">{row.enabled ? "on" : "off"}</p>
      </td>

      {/* Save button */}
      <td className="px-4 py-3">
        {canEdit ? (
          <div className="flex flex-col gap-1">
            <button
              onClick={handleSave}
              disabled={row.saving || !isDirty}
              className={clsx(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
                isDirty && !row.saving
                  ? "bg-blue-500/15 border border-blue-500/30 text-blue-400 hover:bg-blue-500/25"
                  : row.saved
                  ? "bg-emerald-500/15 border border-emerald-500/20 text-emerald-400"
                  : "bg-slate-700/30 border border-slate-700 text-slate-600 cursor-default",
              )}
            >
              {row.saving ? (
                <><Loader2 className="w-3 h-3 animate-spin" /> Saving</>
              ) : row.saved ? (
                <><CheckCircle className="w-3 h-3" /> Saved</>
              ) : (
                <><Save className="w-3 h-3" /> Save</>
              )}
            </button>
            {row.error && (
              <p className="text-[10px] text-red-400">{row.error}</p>
            )}
          </div>
        ) : (
          <span className="text-xs text-slate-600">—</span>
        )}
      </td>
    </tr>
  );
}

// ── Summary bar ────────────────────────────────────────────────────

function SummaryBar({ summary }: { summary: { ok: number; warning: number; critical: number } }) {
  const total = summary.ok + summary.warning + summary.critical;
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-4 px-4 py-2.5 rounded-xl border border-slate-700 bg-slate-800/50">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" />
          <span className="text-sm font-semibold text-white">{summary.ok}</span>
          <span className="text-xs text-slate-400">OK</span>
        </div>
        <div className="w-px h-4 bg-slate-700" />
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-amber-400 inline-block" />
          <span className="text-sm font-semibold text-white">{summary.warning}</span>
          <span className="text-xs text-slate-400">Warning</span>
        </div>
        <div className="w-px h-4 bg-slate-700" />
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-red-400 inline-block" />
          <span className="text-sm font-semibold text-white">{summary.critical}</span>
          <span className="text-xs text-slate-400">Critical</span>
        </div>
        <div className="w-px h-4 bg-slate-700" />
        <span className="text-xs text-slate-500">{total} thresholds</span>
      </div>

      {summary.critical > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-red-500/20 bg-red-500/10 text-red-300 text-xs font-medium">
          <AlertTriangle className="w-3.5 h-3.5" />
          {summary.critical} critical breach{summary.critical > 1 ? "es" : ""}
        </div>
      )}
      {summary.critical === 0 && summary.warning > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-amber-500/20 bg-amber-500/10 text-amber-300 text-xs font-medium">
          <AlertTriangle className="w-3.5 h-3.5" />
          {summary.warning} warning{summary.warning > 1 ? "s" : ""}
        </div>
      )}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────

export default function AlertsPage() {
  const { data: session } = useSession();
  const [data, setData]         = useState<AlertsResponse | null>(null);
  const [loading, setLoading]   = useState(true);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const role     = (session?.user as { role?: string })?.role ?? "viewer";
  const isAdmin  = role === "admin";
  const canEdit  = isAdmin || role === "operator";

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/alerts/thresholds");
      if (res.ok) setData(await res.json());
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  // Initial load
  useEffect(() => { fetchData(); }, [fetchData]);

  // Auto-refresh every 30s
  useEffect(() => {
    const id = setInterval(fetchData, 30_000);
    return () => clearInterval(id);
  }, [fetchData]);

  const handleSaveRow = async (
    id: string,
    patch: { warning?: number; critical?: number; enabled?: boolean },
  ): Promise<boolean> => {
    try {
      const res = await fetch("/api/alerts/thresholds", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...patch }),
      });
      if (!res.ok) return false;
      await fetchData();
      return true;
    } catch {
      return false;
    }
  };

  const handleReset = async () => {
    if (!isAdmin) return;
    if (!confirm("Reset all thresholds to factory defaults? This cannot be undone.")) return;
    setResetting(true);
    setResetError(null);
    try {
      const res = await fetch("/api/alerts/thresholds", { method: "DELETE" });
      if (res.ok) {
        await fetchData();
      } else {
        setResetError("Reset failed — admin role required.");
      }
    } catch {
      setResetError("Network error during reset.");
    }
    setResetting(false);
  };

  return (
    <div className="max-w-6xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <Bell className="w-6 h-6 text-amber-400" />
          <h1 className="text-xl font-bold text-white">Alert Thresholds</h1>
          <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/25">
            Auto-refresh · 30s
          </span>
        </div>
        <div className="flex items-center gap-2">
          {data?.fetched_at && (
            <span className="text-xs text-slate-600">
              {new Date(data.fetched_at).toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={fetchData}
            className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-slate-700 transition-colors"
            title="Refresh now"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          {isAdmin && (
            <button
              onClick={handleReset}
              disabled={resetting}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-700/50 border border-slate-600 text-slate-300 hover:text-white hover:bg-slate-700 disabled:opacity-50 transition-colors"
              title="Reset all thresholds to factory defaults (admin only)"
            >
              {resetting
                ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Resetting…</>
                : <><RotateCcw className="w-3.5 h-3.5" /> Reset Defaults</>}
            </button>
          )}
        </div>
      </div>

      <p className="text-sm text-slate-400 mb-5">
        Configure warning and critical thresholds for live T&T Engine metrics.
        Changes take effect on the next evaluation cycle.
      </p>

      {/* Reset error */}
      {resetError && (
        <div className="flex items-center gap-2 mb-4 px-4 py-3 rounded-xl border border-red-500/20 bg-red-500/10 text-red-300 text-sm">
          <ShieldAlert className="w-4 h-4 shrink-0" />
          {resetError}
        </div>
      )}

      {/* Viewer notice */}
      {!canEdit && (
        <div className="flex items-center gap-2 mb-4 px-4 py-3 rounded-xl border border-slate-700 bg-slate-800/30 text-slate-400 text-xs">
          <ShieldAlert className="w-4 h-4 text-slate-500 shrink-0" />
          Viewer role — thresholds are read-only. Contact an admin or operator to make changes.
        </div>
      )}

      {/* Summary bar */}
      {data?.summary && (
        <div className="mb-5">
          <SummaryBar summary={data.summary} />
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !data && (
        <div className="rounded-xl border border-slate-700 overflow-hidden">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="h-16 border-b border-slate-700/50 last:border-0 bg-slate-800/20 animate-pulse"
            />
          ))}
        </div>
      )}

      {/* Threshold table */}
      {data && (
        <div className="rounded-xl border border-slate-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-800 text-slate-400 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-3">Metric</th>
                <th className="text-left px-4 py-3">Current</th>
                <th className="text-center px-4 py-3">Dir.</th>
                <th className="text-left px-4 py-3">
                  <span className="text-amber-400/80">Warning</span>
                </th>
                <th className="text-left px-4 py-3">
                  <span className="text-red-400/80">Critical</span>
                </th>
                <th className="text-left px-4 py-3">Enabled</th>
                <th className="text-left px-4 py-3">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50">
              {data.thresholds.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-10 text-center text-slate-500 text-sm"
                  >
                    No thresholds configured.
                  </td>
                </tr>
              ) : (
                data.thresholds.map((t) => (
                  <ThresholdRow
                    key={t.id}
                    threshold={t}
                    canEdit={canEdit}
                    onSave={handleSaveRow}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Legend */}
      <div className="mt-4 flex flex-wrap gap-4 text-xs text-slate-500">
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-emerald-400" />
          OK — within safe range
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-amber-400" />
          Warning — approaching limit
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-red-400" />
          Critical — SLO breached
        </span>
        <span className="flex items-center gap-1.5">
          ↑ above / ↓ below — direction the metric must cross to fire
        </span>
      </div>

      <p className="text-xs text-slate-600 mt-3 text-right">
        Metrics sourced from T&T Engine Prometheus endpoint · saved to /tmp/tnt-alert-config.json
      </p>
    </div>
  );
}
