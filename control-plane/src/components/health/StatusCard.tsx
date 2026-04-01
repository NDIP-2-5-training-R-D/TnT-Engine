"use client";

import clsx from "clsx";
import { CheckCircle, XCircle, AlertTriangle, Loader2 } from "lucide-react";

interface StatusCardProps {
  title: string;
  status: string;
  details?: string;
  metric?: string | number;
  metricLabel?: string;
}

const statusConfig: Record<string, { color: string; icon: typeof CheckCircle; label: string }> = {
  healthy:       { color: "text-vault-green border-vault-green/30 bg-vault-green/5", icon: CheckCircle, label: "Healthy" },
  ok:            { color: "text-vault-green border-vault-green/30 bg-vault-green/5", icon: CheckCircle, label: "OK" },
  connected:     { color: "text-vault-green border-vault-green/30 bg-vault-green/5", icon: CheckCircle, label: "Connected" },
  CLOSED:        { color: "text-vault-green border-vault-green/30 bg-vault-green/5", icon: CheckCircle, label: "Closed" },
  standby:       { color: "text-vault-yellow border-vault-yellow/30 bg-vault-yellow/5", icon: AlertTriangle, label: "Standby" },
  degraded:      { color: "text-vault-yellow border-vault-yellow/30 bg-vault-yellow/5", icon: AlertTriangle, label: "Degraded" },
  HALF_OPEN:     { color: "text-vault-yellow border-vault-yellow/30 bg-vault-yellow/5", icon: AlertTriangle, label: "Half-Open" },
  sealed:        { color: "text-vault-red border-vault-red/30 bg-vault-red/5", icon: XCircle, label: "SEALED" },
  unreachable:   { color: "text-vault-red border-vault-red/30 bg-vault-red/5", icon: XCircle, label: "Unreachable" },
  OPEN:          { color: "text-vault-red border-vault-red/30 bg-vault-red/5", icon: XCircle, label: "OPEN" },
  disconnected:  { color: "text-vault-red border-vault-red/30 bg-vault-red/5", icon: XCircle, label: "Disconnected" },
};

export default function StatusCard({ title, status, details, metric, metricLabel }: StatusCardProps) {
  const cfg = statusConfig[status] ?? { color: "text-slate-400 border-slate-600 bg-slate-800", icon: Loader2, label: status };
  const Icon = cfg.icon;

  return (
    <div className={clsx("rounded-xl border p-4 transition-all", cfg.color)}>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-slate-300">{title}</h3>
        <Icon className="w-5 h-5" />
      </div>
      <p className="text-lg font-bold">{cfg.label}</p>
      {details && <p className="text-xs text-slate-400 mt-1">{details}</p>}
      {metric !== undefined && (
        <div className="mt-2 pt-2 border-t border-slate-700/50">
          <span className="text-xl font-mono font-bold">{metric}</span>
          {metricLabel && <span className="text-xs text-slate-500 ml-1">{metricLabel}</span>}
        </div>
      )}
    </div>
  );
}
