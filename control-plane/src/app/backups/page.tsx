"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import { Database, Download, Clock, CheckCircle, XCircle, Loader2, RefreshCw, Settings } from "lucide-react";
import clsx from "clsx";

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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function BackupsPage() {
  const { data: session } = useSession();
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [schedule, setSchedule] = useState<ScheduleConfig>({ enabled: false, interval_hours: 4, retention_count: 10 });
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const role = (session?.user as any)?.role || "viewer";
  const canTrigger = role === "admin" || role === "operator";

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/backups");
      if (res.ok) {
        const data = await res.json();
        setBackups(data.backups || []);
        setSchedule(data.schedule || schedule);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const triggerBackup = async () => {
    setTriggering(true);
    try {
      await fetch("/api/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "trigger" }),
      });
      fetchData();
    } catch { /* ignore */ }
    setTriggering(false);
  };

  const saveSchedule = async () => {
    await fetch("/api/backups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "update_schedule", ...schedule }),
    });
    setShowSettings(false);
  };

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Database className="w-6 h-6 text-vault-blue" />
          <h1 className="text-xl font-bold text-white">Backup Management</h1>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowSettings(!showSettings)} className="p-2 text-slate-500 hover:text-white"><Settings className="w-4 h-4" /></button>
          <button onClick={fetchData} className="p-2 text-slate-500 hover:text-white"><RefreshCw className="w-4 h-4" /></button>
          {canTrigger && (
            <button onClick={triggerBackup} disabled={triggering}
              className="flex items-center gap-2 px-4 py-2 bg-vault-blue/20 border border-vault-blue/40 rounded-lg text-vault-blue text-sm font-medium disabled:opacity-50">
              {triggering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              {triggering ? "Creating..." : "Backup Now"}
            </button>
          )}
        </div>
      </div>

      {/* Schedule Settings */}
      {showSettings && (
        <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-5 mb-6 space-y-3">
          <h3 className="text-sm font-semibold text-white">Backup Schedule</h3>
          <div className="grid grid-cols-3 gap-4">
            <label className="space-y-1">
              <span className="text-xs text-slate-400">Enabled</span>
              <select value={schedule.enabled ? "yes" : "no"} onChange={(e) => setSchedule({ ...schedule, enabled: e.target.value === "yes" })}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded text-white text-sm">
                <option value="yes">Yes</option><option value="no">No</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-slate-400">Interval (hours)</span>
              <input type="number" value={schedule.interval_hours} min={1} max={24}
                onChange={(e) => setSchedule({ ...schedule, interval_hours: +e.target.value })}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded text-white text-sm font-mono" />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-slate-400">Retention (count)</span>
              <input type="number" value={schedule.retention_count} min={1} max={100}
                onChange={(e) => setSchedule({ ...schedule, retention_count: +e.target.value })}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded text-white text-sm font-mono" />
            </label>
          </div>
          {canTrigger && (
            <button onClick={saveSchedule} className="px-4 py-1.5 bg-vault-blue/20 border border-vault-blue/40 rounded text-xs text-vault-blue">Save Schedule</button>
          )}
        </div>
      )}

      {/* Backup History */}
      <div className="rounded-xl border border-slate-700 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-800 text-slate-400">
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
              <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-500"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></td></tr>
            ) : backups.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-500">No backups yet. Click "Backup Now" to create one.</td></tr>
            ) : backups.map((b) => (
              <tr key={b.id} className="hover:bg-slate-800/30">
                <td className="px-4 py-2">
                  {b.status === "completed" || b.status === "verified" ? (
                    <CheckCircle className="w-4 h-4 text-vault-green" />
                  ) : (
                    <XCircle className="w-4 h-4 text-vault-red" />
                  )}
                </td>
                <td className="px-4 py-2 text-slate-300">{new Date(b.timestamp).toLocaleString()}</td>
                <td className="px-4 py-2 font-mono text-white">{formatBytes(b.size_bytes)}</td>
                <td className="px-4 py-2 font-mono text-slate-400">{b.duration_ms}ms</td>
                <td className="px-4 py-2 text-slate-400">{b.triggered_by}</td>
                <td className="px-4 py-2 font-mono text-xs text-slate-600">{b.checksum_sha256?.slice(0, 16) || "-"}...</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
