"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSession } from "next-auth/react";
import {
  Database, Download, CheckCircle, XCircle, Loader2,
  RefreshCw, Settings, UploadCloud, AlertTriangle,
  ShieldAlert, FileCheck, Clock, CheckCheck, Play,
  AlertCircle,
} from "lucide-react";
import clsx from "clsx";

// ── Types ──────────────────────────────────────────────────────────

interface BackupRecord {
  id: string;
  timestamp: string;
  size_bytes: number;
  checksum_sha256: string;
  storage_location: string;
  status: string;
  triggered_by: string;
  vault_version: string;
  duration_ms: number;
  error?: string;
}

interface ScheduleConfig {
  enabled: boolean;
  interval_hours: number;
  retention_count: number;
}

interface ScheduleStatus {
  enabled: boolean;
  interval_hours: number;
  retention_count: number;
  cron_expression: string;
  last_run_at: string | null;
  last_run_status: "success" | "failed" | null;
  next_run_at: string | null;
  is_overdue: boolean;
  seconds_until_next: number | null;
}

interface RestoreResult {
  success: boolean;
  message?: string;
  error?: string;
  checksum_sha256: string;
  filename?: string;
  size_bytes: number;
  duration_ms: number;
  restored_by?: string;
  restored_at?: string;
  warning?: string;
}

type Tab = "history" | "schedule" | "restore";

// ── Helpers ────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── History Tab ────────────────────────────────────────────────────

function HistoryTab({
  backups, loading, canTrigger, onTrigger, onRefresh,
}: {
  backups: BackupRecord[];
  loading: boolean;
  canTrigger: boolean;
  onTrigger: () => void;
  onRefresh: () => void;
}) {
  const [triggering, setTriggering] = useState(false);

  const handleTrigger = async () => {
    setTriggering(true);
    await onTrigger();
    setTriggering(false);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-slate-400">
          Raft snapshots stored locally. Latest {backups.length} shown.
        </p>
        <div className="flex items-center gap-2">
          <button onClick={onRefresh} className="p-1.5 rounded text-slate-500 hover:text-white transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
          {canTrigger && (
            <button
              onClick={handleTrigger}
              disabled={triggering}
              className="flex items-center gap-2 px-4 py-2 bg-blue-500/15 border border-blue-500/30 rounded-lg text-blue-400 text-sm font-medium hover:bg-blue-500/25 disabled:opacity-50 transition-colors"
            >
              {triggering
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Creating…</>
                : <><Download className="w-4 h-4" /> Backup Now</>}
            </button>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-slate-700 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-800 text-slate-400 text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left px-4 py-3">Status</th>
              <th className="text-left px-4 py-3">Timestamp</th>
              <th className="text-left px-4 py-3">Size</th>
              <th className="text-left px-4 py-3">Duration</th>
              <th className="text-left px-4 py-3">Triggered By</th>
              <th className="text-left px-4 py-3">Checksum</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/50">
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-slate-500">
                  <Loader2 className="w-5 h-5 animate-spin mx-auto" />
                </td>
              </tr>
            ) : backups.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-slate-500">
                  No backups yet. Click <strong className="text-slate-400">Backup Now</strong> to create one.
                </td>
              </tr>
            ) : backups.map((b) => (
              <tr key={b.id} className="hover:bg-slate-800/30 transition-colors">
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-1.5">
                    {b.status === "completed" || b.status === "verified"
                      ? <CheckCircle className="w-4 h-4 text-emerald-400" />
                      : <XCircle className="w-4 h-4 text-red-400" />}
                    <span className={clsx("text-xs capitalize",
                      b.status === "verified" ? "text-emerald-400"
                        : b.status === "completed" ? "text-slate-300"
                          : "text-red-400",
                    )}>{b.status}</span>
                  </div>
                  {b.error && <p className="text-[10px] text-red-400/70 mt-0.5">{b.error}</p>}
                </td>
                <td className="px-4 py-2.5 text-slate-300 text-xs">
                  {new Date(b.timestamp).toLocaleString()}
                </td>
                <td className="px-4 py-2.5 font-mono text-white text-xs">{formatBytes(b.size_bytes)}</td>
                <td className="px-4 py-2.5 font-mono text-slate-400 text-xs">{b.duration_ms}ms</td>
                <td className="px-4 py-2.5 text-slate-400 text-xs">{b.triggered_by}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-slate-600">
                  {b.checksum_sha256 ? `${b.checksum_sha256.slice(0, 16)}…` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Schedule Tab ───────────────────────────────────────────────────

/** Format ISO timestamp as "YYYY-MM-DD HH:mm" in local time */
function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** Convert seconds into "Xh Ym" / "Ym Zs" human-readable string */
function formatCountdown(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds <= 0) return "now";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function ScheduleTab({
  schedule, canEdit, onSave,
}: {
  schedule: ScheduleConfig;
  canEdit: boolean;
  onSave: (cfg: ScheduleConfig) => Promise<void>;
}) {
  const [local, setLocal]       = useState<ScheduleConfig>(schedule);
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);
  const [running, setRunning]   = useState(false);
  const [runMsg, setRunMsg]     = useState<{ ok: boolean; text: string } | null>(null);
  const [status, setStatus]     = useState<ScheduleStatus | null>(null);
  const [statusErr, setStatusErr] = useState(false);
  // Live countdown tick
  const [, setTick] = useState(0);

  useEffect(() => { setLocal(schedule); }, [schedule]);

  // Poll /api/backups/schedule/status every 30 s
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/backups/schedule/status");
      if (res.ok) {
        setStatus(await res.json());
        setStatusErr(false);
      } else {
        setStatusErr(true);
      }
    } catch {
      setStatusErr(true);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 30_000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // Tick every second to keep countdown fresh
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(t);
  }, []);

  const handleSave = async () => {
    setSaving(true);
    await onSave(local);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2_000);
    // Refresh status after save
    await fetchStatus();
  };

  const handleRunNow = async () => {
    setRunning(true);
    setRunMsg(null);
    try {
      const res = await fetch("/api/backups/schedule/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      const data = await res.json();
      if (data.executed) {
        setRunMsg({ ok: true, text: `Backup executed — ${data.duration_ms ?? 0}ms` });
      } else {
        setRunMsg({ ok: false, text: data.reason ?? data.error ?? "Not executed" });
      }
    } catch {
      setRunMsg({ ok: false, text: "Network error" });
    } finally {
      setRunning(false);
      await fetchStatus();
    }
  };

  // Compute live seconds_until_next from status.next_run_at
  const liveSeconds: number | null = status?.next_run_at
    ? Math.round((Date.parse(status.next_run_at) - Date.now()) / 1000)
    : null;

  const dotColor = !status?.enabled
    ? "bg-slate-500"
    : status.is_overdue
    ? "bg-red-400"
    : status.last_run_status === "failed"
    ? "bg-amber-400"
    : "bg-emerald-400";

  const generatedCron =
    local.interval_hours === 1  ? "0 * * * *"        :
    local.interval_hours === 24 ? "0 0 * * *"        :
                                  `0 */${local.interval_hours} * * *`;

  return (
    <div className="max-w-lg space-y-4">

      {/* ── Schedule Status card ─────────────────────────────── */}
      <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={clsx("inline-block w-2.5 h-2.5 rounded-full shrink-0", dotColor)} />
            <span className="text-sm font-semibold text-white">Schedule Status</span>
          </div>
          <div className="flex items-center gap-2">
            {/* Enabled / Disabled badge */}
            {status ? (
              <span className={clsx(
                "text-xs px-2 py-0.5 rounded border font-medium",
                status.enabled
                  ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/25"
                  : "bg-slate-700 text-slate-400 border-slate-600",
              )}>
                {status.enabled ? "Enabled" : "Disabled"}
              </span>
            ) : null}
            {/* Overdue badge */}
            {status?.is_overdue && (
              <span className="text-xs px-2 py-0.5 rounded border bg-red-500/15 text-red-400 border-red-500/25 font-semibold">
                OVERDUE
              </span>
            )}
            <button
              onClick={fetchStatus}
              className="p-1 rounded text-slate-500 hover:text-white transition-colors"
              title="Refresh status"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {statusErr && (
          <div className="flex items-center gap-2 text-xs text-amber-400">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            Could not load schedule status.
          </div>
        )}

        {status && (
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            {/* Next run */}
            <div>
              <p className="text-slate-500 mb-0.5">Next run in</p>
              <p className={clsx(
                "font-mono font-medium",
                status.is_overdue ? "text-red-400" : "text-white",
              )}>
                {status.enabled
                  ? status.next_run_at
                    ? formatCountdown(liveSeconds)
                    : "First run pending"
                  : "—"}
              </p>
            </div>
            {/* Cron expr */}
            <div>
              <p className="text-slate-500 mb-0.5">Cron expression</p>
              <p className="font-mono text-slate-300">{status.cron_expression}</p>
            </div>
            {/* Last run */}
            <div className="col-span-2">
              <p className="text-slate-500 mb-0.5">Last run</p>
              <div className="flex items-center gap-1.5">
                {status.last_run_status === "success" && (
                  <CheckCircle className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                )}
                {status.last_run_status === "failed" && (
                  <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                )}
                <span className={clsx(
                  "font-mono",
                  !status.last_run_at ? "text-slate-600"
                    : status.last_run_status === "success" ? "text-slate-300"
                    : "text-red-300",
                )}>
                  {status.last_run_at
                    ? `${formatDateTime(status.last_run_at)} — ${status.last_run_status === "success" ? "Success" : "Failed"}`
                    : "No runs yet"}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Run Now button */}
        {canEdit && (
          <div className="pt-1 flex items-center gap-3">
            <button
              onClick={handleRunNow}
              disabled={running}
              className="flex items-center gap-2 px-3 py-1.5 bg-emerald-500/15 border border-emerald-500/30 rounded-lg text-emerald-400 text-xs font-medium hover:bg-emerald-500/25 disabled:opacity-50 transition-colors"
            >
              {running
                ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Running…</>
                : <><Play className="w-3.5 h-3.5" /> Run Now</>}
            </button>
            {runMsg && (
              <span className={clsx("text-xs", runMsg.ok ? "text-emerald-400" : "text-red-400")}>
                {runMsg.text}
              </span>
            )}
          </div>
        )}
      </div>

      {/* ── Schedule Config card ──────────────────────────────── */}
      <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-5 space-y-4">
        <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Configuration</p>

        <div>
          <label className="text-xs text-slate-400 block mb-1.5">Auto-backup Enabled</label>
          <select
            value={local.enabled ? "yes" : "no"}
            onChange={(e) => setLocal({ ...local, enabled: e.target.value === "yes" })}
            disabled={!canEdit}
            className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
          >
            <option value="yes">Yes — run on schedule</option>
            <option value="no">No — manual only</option>
          </select>
        </div>

        <div>
          <label className="text-xs text-slate-400 block mb-1.5">Interval (hours, 1–24)</label>
          <input
            type="number"
            value={local.interval_hours}
            min={1} max={24}
            onChange={(e) => setLocal({ ...local, interval_hours: Number(e.target.value) })}
            disabled={!canEdit}
            className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-white text-sm font-mono focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
          />
        </div>

        <div>
          <label className="text-xs text-slate-400 block mb-1.5">Retention (keep last N backups, 1–100)</label>
          <input
            type="number"
            value={local.retention_count}
            min={1} max={100}
            onChange={(e) => setLocal({ ...local, retention_count: Number(e.target.value) })}
            disabled={!canEdit}
            className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-white text-sm font-mono focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
          />
        </div>

        {/* Generated cron expression — read-only */}
        <div>
          <label className="text-xs text-slate-400 block mb-1.5">Generated cron expression</label>
          <div className="w-full px-3 py-2 bg-slate-900/60 border border-slate-700 rounded-lg font-mono text-sm text-slate-400 select-all">
            {generatedCron}
          </div>
        </div>

        {canEdit ? (
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 bg-blue-500/15 border border-blue-500/30 rounded-lg text-blue-400 text-sm font-medium hover:bg-blue-500/25 disabled:opacity-50 transition-colors"
          >
            {saving
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
              : saved
              ? <><CheckCheck className="w-4 h-4" /> Saved</>
              : "Save"}
          </button>
        ) : (
          <p className="text-xs text-slate-500">Viewer role — schedule is read-only.</p>
        )}
      </div>
    </div>
  );
}

// ── Restore Tab ────────────────────────────────────────────────────

type RestoreStep = "idle" | "file-selected" | "confirm" | "restoring" | "done" | "error";

function RestoreTab({ isAdmin }: { isAdmin: boolean }) {
  const [step, setStep] = useState<RestoreStep>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [fileChecksum, setFileChecksum] = useState<string>("");
  const [confirmPhrase, setConfirmPhrase] = useState("");
  const [result, setResult] = useState<RestoreResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [computing, setComputing] = useState(false);

  // Compute SHA256 of the selected file in-browser for display
  async function computeChecksum(f: File): Promise<string> {
    const buf = await f.arrayBuffer();
    const hashBuf = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  const handleFileChange = async (f: File | null) => {
    if (!f) { setFile(null); setFileChecksum(""); setStep("idle"); return; }
    setFile(f);
    setStep("file-selected");
    setComputing(true);
    try {
      const hash = await computeChecksum(f);
      setFileChecksum(hash);
    } finally {
      setComputing(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0] ?? null;
    if (f) handleFileChange(f);
  };

  const handleRestore = async () => {
    if (!file || confirmPhrase !== "RESTORE") return;
    setStep("restoring");

    const formData = new FormData();
    formData.append("snapshot", file);
    formData.append("confirm", confirmPhrase);

    try {
      const res = await fetch("/api/backups/restore", { method: "POST", body: formData });
      const data: RestoreResult = await res.json();
      setResult(data);
      setStep(data.success ? "done" : "error");
    } catch {
      setResult({ success: false, error: "Network error", checksum_sha256: fileChecksum, size_bytes: file.size, duration_ms: 0 });
      setStep("error");
    }
  };

  const reset = () => {
    setStep("idle"); setFile(null); setFileChecksum("");
    setConfirmPhrase(""); setResult(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  if (!isAdmin) {
    return (
      <div className="flex items-center gap-3 p-5 rounded-xl border border-slate-700 bg-slate-800/30 text-slate-400 text-sm">
        <ShieldAlert className="w-5 h-5 text-amber-400 shrink-0" />
        Restore requires <strong className="text-white">admin</strong> role. This operation is irreversible.
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-5">
      {/* Warning banner */}
      <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-xs">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
        <div>
          <strong className="text-red-200">Destructive operation.</strong> Restoring a Raft snapshot
          overwrites all current vault data with the snapshot state. Any tokens or keys created after
          the snapshot was taken will be <strong className="text-red-200">permanently lost</strong>.
          Only proceed if instructed by a runbook.
        </div>
      </div>

      {/* File upload */}
      {(step === "idle" || step === "file-selected") && (
        <div>
          <label className="text-xs text-slate-400 mb-2 block">Select Raft Snapshot File (.snap)</label>
          <div
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => inputRef.current?.click()}
            className={clsx(
              "rounded-xl border-2 border-dashed p-8 flex flex-col items-center gap-3 cursor-pointer transition-colors",
              file ? "border-blue-500/40 bg-blue-500/5" : "border-slate-600 bg-slate-800/30 hover:border-slate-500",
            )}
          >
            <UploadCloud className={clsx("w-8 h-8", file ? "text-blue-400" : "text-slate-600")} />
            {file ? (
              <div className="text-center">
                <p className="text-sm font-medium text-white">{file.name}</p>
                <p className="text-xs text-slate-400 mt-1">{formatBytes(file.size)}</p>
              </div>
            ) : (
              <div className="text-center">
                <p className="text-sm text-slate-400">Drop a <code className="text-slate-300">.snap</code> file here</p>
                <p className="text-xs text-slate-600 mt-1">or click to browse</p>
              </div>
            )}
            <input
              ref={inputRef}
              type="file"
              accept=".snap"
              className="hidden"
              onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)}
            />
          </div>
        </div>
      )}

      {/* Checksum display */}
      {file && step === "file-selected" && (
        <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <FileCheck className="w-4 h-4 text-blue-400" />
            <span className="text-sm font-medium text-white">File Verification</span>
          </div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <p className="text-slate-500 mb-1">File name</p>
              <p className="font-mono text-slate-200 break-all">{file.name}</p>
            </div>
            <div>
              <p className="text-slate-500 mb-1">File size</p>
              <p className="font-mono text-slate-200">{formatBytes(file.size)}</p>
            </div>
          </div>
          <div>
            <p className="text-slate-500 text-xs mb-1">SHA-256 checksum</p>
            {computing
              ? <div className="flex items-center gap-2 text-xs text-slate-500"><Loader2 className="w-3 h-3 animate-spin" /> Computing…</div>
              : <p className="font-mono text-xs text-emerald-300 break-all">{fileChecksum}</p>}
          </div>
          <p className="text-xs text-slate-500">
            Verify this checksum matches your backup record before proceeding.
          </p>
          <button
            onClick={() => setStep("confirm")}
            disabled={computing}
            className="px-4 py-2 bg-amber-500/15 border border-amber-500/30 rounded-lg text-amber-400 text-sm font-medium hover:bg-amber-500/25 disabled:opacity-50 transition-colors"
          >
            Continue to Confirmation →
          </button>
        </div>
      )}

      {/* Confirmation step */}
      {step === "confirm" && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-5 space-y-4">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-400" />
            <span className="text-sm font-semibold text-red-300">Final confirmation required</span>
          </div>
          <div className="text-xs text-slate-400 space-y-1">
            <p>Snapshot: <span className="font-mono text-slate-200">{file?.name}</span></p>
            <p>Size: <span className="font-mono text-slate-200">{formatBytes(file?.size ?? 0)}</span></p>
            <p className="text-xs font-mono text-slate-500 break-all">SHA-256: {fileChecksum}</p>
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1.5">
              Type <code className="text-red-300 font-mono">RESTORE</code> to confirm
            </label>
            <input
              type="text"
              value={confirmPhrase}
              onChange={(e) => setConfirmPhrase(e.target.value)}
              placeholder="RESTORE"
              autoComplete="off"
              className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-white text-sm font-mono focus:outline-none focus:ring-1 focus:ring-red-500"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={reset}
              className="px-4 py-2 rounded-lg text-slate-400 text-sm border border-slate-600 hover:bg-slate-700 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleRestore}
              disabled={confirmPhrase !== "RESTORE"}
              className="flex items-center gap-2 px-4 py-2 bg-red-600/80 hover:bg-red-600 rounded-lg text-white text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <UploadCloud className="w-4 h-4" />
              Restore Snapshot
            </button>
          </div>
        </div>
      )}

      {/* Restoring in progress */}
      {step === "restoring" && (
        <div className="flex flex-col items-center gap-4 py-10 rounded-xl border border-slate-700 bg-slate-800/30">
          <Loader2 className="w-8 h-8 text-blue-400 animate-spin" />
          <div className="text-center">
            <p className="text-sm font-medium text-white">Restoring snapshot…</p>
            <p className="text-xs text-slate-500 mt-1">Uploading to OpenBao. This may take up to 2 minutes.</p>
          </div>
        </div>
      )}

      {/* Result */}
      {(step === "done" || step === "error") && result && (
        <div className={clsx(
          "rounded-xl border p-5 space-y-3",
          result.success ? "border-emerald-500/20 bg-emerald-500/5" : "border-red-500/20 bg-red-500/5",
        )}>
          <div className="flex items-center gap-2">
            {result.success
              ? <CheckCircle className="w-5 h-5 text-emerald-400" />
              : <XCircle className="w-5 h-5 text-red-400" />}
            <span className={clsx("font-semibold text-sm", result.success ? "text-emerald-300" : "text-red-300")}>
              {result.success ? "Restore completed" : "Restore failed"}
            </span>
            <span className="text-xs text-slate-500 font-mono">{result.duration_ms}ms</span>
          </div>

          {result.success && (
            <div className="text-xs text-slate-400 space-y-1">
              <p>{result.message}</p>
              <p>Restored by: <span className="text-slate-200">{result.restored_by}</span></p>
              <p>Checksum: <span className="font-mono text-slate-300">{result.checksum_sha256.slice(0, 32)}…</span></p>
            </div>
          )}

          {result.warning && (
            <div className="flex items-start gap-2 text-xs text-amber-300 px-3 py-2 bg-amber-500/10 rounded-lg border border-amber-500/15">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              {result.warning}
            </div>
          )}

          {result.error && (
            <p className="text-xs text-red-300">{result.error}</p>
          )}

          <button
            onClick={reset}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            ← Start over
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────

export default function BackupsPage() {
  const { data: session } = useSession();
  const [backups, setBackups]   = useState<BackupRecord[]>([]);
  const [schedule, setSchedule] = useState<ScheduleConfig>({ enabled: false, interval_hours: 4, retention_count: 10 });
  const [loading, setLoading]   = useState(true);
  const [tab, setTab]           = useState<Tab>("history");

  const role     = (session?.user as { role?: string })?.role ?? "requester";
  const isAdmin  = role === "admin";
  const canWrite = isAdmin || role === "manager";

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/backups");
      if (res.ok) {
        const data = await res.json();
        setBackups(data.backups ?? []);
        setSchedule(data.schedule ?? schedule);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchData(); }, [fetchData]);

  const triggerBackup = async () => {
    await fetch("/api/backups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "trigger" }),
    });
    await fetchData();
  };

  const saveSchedule = async (cfg: ScheduleConfig) => {
    await fetch("/api/backups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "update_schedule", ...cfg }),
    });
    setSchedule(cfg);
  };

  const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "history",  label: "History",  icon: <Clock className="w-3.5 h-3.5" /> },
    { id: "schedule", label: "Schedule", icon: <Settings className="w-3.5 h-3.5" /> },
    { id: "restore",  label: "Restore",  icon: <UploadCloud className="w-3.5 h-3.5" /> },
  ];

  return (
    <div className="max-w-5xl">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Database className="w-6 h-6 text-blue-400" />
        <h1 className="text-xl font-bold text-white">Backup Management</h1>
        {isAdmin && (
          <span className="text-xs px-2 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/25">
            Restore available
          </span>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-5 bg-slate-800/50 rounded-xl border border-slate-700 p-1 w-fit">
        {TABS.map(({ id, label, icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={clsx(
              "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors",
              tab === id
                ? "bg-slate-700 text-white"
                : "text-slate-400 hover:text-white hover:bg-slate-700/40",
              id === "restore" && tab !== "restore" && "text-amber-400/70 hover:text-amber-300",
            )}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "history" && (
        <HistoryTab
          backups={backups}
          loading={loading}
          canTrigger={canWrite}
          onTrigger={triggerBackup}
          onRefresh={fetchData}
        />
      )}
      {tab === "schedule" && (
        <ScheduleTab
          schedule={schedule}
          canEdit={canWrite}
          onSave={saveSchedule}
        />
      )}
      {tab === "restore" && (
        <RestoreTab isAdmin={isAdmin} />
      )}
    </div>
  );
}
