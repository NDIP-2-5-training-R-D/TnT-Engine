"use client";

import { useState } from "react";
import {
  FileDown,
  Calendar,
  Building2,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  FileJson,
  FileSpreadsheet,
  Shield,
  BarChart3,
} from "lucide-react";

type ExportFormat = "json" | "csv";

interface ReportConfig {
  from_date: string;
  to_date: string;
  tenant_id: string;
  format: ExportFormat;
  include_pii_summary: boolean;
}

function formatDateForInput(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const PRESETS = [
  { label: "Last 7 days",  days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
  { label: "Last year",    days: 365 },
];

export default function CompliancePage() {
  const today = new Date();
  const [config, setConfig] = useState<ReportConfig>({
    from_date: formatDateForInput(new Date(Date.now() - 30 * 86400_000)),
    to_date: formatDateForInput(today),
    tenant_id: "",
    format: "json",
    include_pii_summary: true,
  });
  const [loading, setLoading] = useState(false);
  const [lastExport, setLastExport] = useState<{
    filename: string;
    rows: number;
    ts: string;
  } | null>(null);
  const [error, setError] = useState("");

  function applyPreset(days: number) {
    setConfig((c) => ({
      ...c,
      from_date: formatDateForInput(new Date(Date.now() - days * 86400_000)),
      to_date: formatDateForInput(today),
    }));
  }

  async function handleExport() {
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/compliance/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }

      // Trigger browser download
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match?.[1] ?? `compliance-report.${config.format}`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);

      // Estimate row count from blob size (rough approximation)
      const roughRows = Math.max(1, Math.round(blob.size / 180));
      setLastExport({ filename, rows: roughRows, ts: new Date().toLocaleTimeString() });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <Shield className="w-6 h-6 text-vault-green" />
        <div>
          <h1 className="text-xl font-semibold text-white">Compliance Reports</h1>
          <p className="text-sm text-slate-500">
            Export regulatory-grade audit reports for PCI-DSS, GDPR, and SOC 2 compliance.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Configuration panel */}
        <div className="lg:col-span-2 space-y-4">
          {/* Date range */}
          <div className="rounded-xl border border-slate-700 bg-slate-900 p-5 space-y-4">
            <div className="flex items-center gap-2 mb-1">
              <Calendar className="w-4 h-4 text-slate-400" />
              <h2 className="text-sm font-medium text-slate-300">Report Period</h2>
            </div>

            {/* Presets */}
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.days}
                  onClick={() => applyPreset(p.days)}
                  className="px-3 py-1 text-xs rounded-md bg-slate-800 border border-slate-600 text-slate-300 hover:border-vault-green/50 hover:text-vault-green transition-colors"
                >
                  {p.label}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-slate-400 mb-1">From date</label>
                <input
                  type="date"
                  value={config.from_date}
                  onChange={(e) => setConfig((c) => ({ ...c, from_date: e.target.value }))}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-sm text-white focus:border-vault-green focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">To date</label>
                <input
                  type="date"
                  value={config.to_date}
                  onChange={(e) => setConfig((c) => ({ ...c, to_date: e.target.value }))}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-sm text-white focus:border-vault-green focus:outline-none"
                />
              </div>
            </div>
          </div>

          {/* Filters */}
          <div className="rounded-xl border border-slate-700 bg-slate-900 p-5 space-y-4">
            <div className="flex items-center gap-2 mb-1">
              <Building2 className="w-4 h-4 text-slate-400" />
              <h2 className="text-sm font-medium text-slate-300">Filters</h2>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Tenant ID <span className="text-slate-600">(leave empty for all tenants)</span>
              </label>
              <input
                type="text"
                value={config.tenant_id}
                onChange={(e) => setConfig((c) => ({ ...c, tenant_id: e.target.value }))}
                placeholder="e.g. acme-corp"
                className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-600 focus:border-vault-green focus:outline-none"
              />
            </div>
          </div>

          {/* Export options */}
          <div className="rounded-xl border border-slate-700 bg-slate-900 p-5 space-y-4">
            <div className="flex items-center gap-2 mb-1">
              <FileDown className="w-4 h-4 text-slate-400" />
              <h2 className="text-sm font-medium text-slate-300">Export Options</h2>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {(["json", "csv"] as ExportFormat[]).map((fmt) => (
                <button
                  key={fmt}
                  onClick={() => setConfig((c) => ({ ...c, format: fmt }))}
                  className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${
                    config.format === fmt
                      ? "border-vault-green bg-vault-green/10 text-vault-green"
                      : "border-slate-700 bg-slate-800 text-slate-400 hover:border-slate-500"
                  }`}
                >
                  {fmt === "json" ? (
                    <FileJson className="w-5 h-5" />
                  ) : (
                    <FileSpreadsheet className="w-5 h-5" />
                  )}
                  <div className="text-left">
                    <p className="text-sm font-medium uppercase">{fmt}</p>
                    <p className="text-[10px] text-slate-500">
                      {fmt === "json" ? "Structured + summary" : "Spreadsheet-compatible"}
                    </p>
                  </div>
                </button>
              ))}
            </div>

            <label className="flex items-center gap-3 cursor-pointer group">
              <div
                onClick={() => setConfig((c) => ({ ...c, include_pii_summary: !c.include_pii_summary }))}
                className={`w-9 h-5 rounded-full relative transition-colors ${
                  config.include_pii_summary ? "bg-vault-green/70" : "bg-slate-700"
                }`}
              >
                <span
                  className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                    config.include_pii_summary ? "translate-x-4" : "translate-x-0.5"
                  }`}
                />
              </div>
              <div>
                <p className="text-sm text-slate-300">Include PII field breakdown</p>
                <p className="text-xs text-slate-500">Count of operations per field type (ssn, email, card…)</p>
              </div>
            </label>
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 text-sm text-vault-red rounded-lg bg-red-900/20 border border-red-800/30 px-4 py-3">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}

          {/* Export button */}
          <button
            onClick={handleExport}
            disabled={loading || !config.from_date || !config.to_date}
            className="w-full flex items-center justify-center gap-2 py-3 bg-vault-green/20 border border-vault-green/40 rounded-xl text-vault-green font-medium hover:bg-vault-green/30 transition-colors disabled:opacity-40"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Generating report…
              </>
            ) : (
              <>
                <FileDown className="w-4 h-4" />
                Export Compliance Report
              </>
            )}
          </button>
        </div>

        {/* Sidebar info */}
        <div className="space-y-4">
          {/* Last export */}
          {lastExport && (
            <div className="rounded-xl border border-vault-green/30 bg-vault-green/5 p-4">
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle2 className="w-4 h-4 text-vault-green" />
                <span className="text-sm font-medium text-vault-green">Export successful</span>
              </div>
              <p className="text-xs text-slate-400 font-mono break-all">{lastExport.filename}</p>
              <p className="text-xs text-slate-500 mt-1">at {lastExport.ts}</p>
            </div>
          )}

          {/* Standards coverage */}
          <div className="rounded-xl border border-slate-700 bg-slate-900 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-slate-400" />
              <h3 className="text-sm font-medium text-slate-300">Standards Coverage</h3>
            </div>
            {[
              { name: "PCI-DSS v4.0",  desc: "Card tokenization audit trail",        ok: true },
              { name: "GDPR Art. 30",  desc: "Processing activity records",           ok: true },
              { name: "SOC 2 Type II", desc: "Crypto operation evidence",             ok: true },
              { name: "HIPAA §164",    desc: "PHI de-identification records",         ok: false },
            ].map((s) => (
              <div key={s.name} className="flex items-start gap-2">
                <span className={`mt-0.5 text-xs font-bold ${s.ok ? "text-vault-green" : "text-slate-600"}`}>
                  {s.ok ? "✓" : "○"}
                </span>
                <div>
                  <p className={`text-xs font-medium ${s.ok ? "text-slate-200" : "text-slate-600"}`}>
                    {s.name}
                  </p>
                  <p className="text-[10px] text-slate-500">{s.desc}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Report contents */}
          <div className="rounded-xl border border-slate-700 bg-slate-900 p-4 space-y-2">
            <h3 className="text-sm font-medium text-slate-300 mb-2">Report Includes</h3>
            {[
              "Total operations & error rate",
              "Operations by type (TOKENIZE / MASK / HMAC…)",
              "PII field breakdown (when enabled)",
              "Per-tenant coverage list",
              "Full audit log entries",
              "Report metadata & generation timestamp",
            ].map((item) => (
              <div key={item} className="flex items-center gap-2">
                <span className="text-vault-green text-xs">✓</span>
                <span className="text-xs text-slate-400">{item}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
