"use client";

import { useMetrics } from "@/lib/api";
import { Activity, Hash, AlertCircle } from "lucide-react";

export default function MetricsPanel() {
  const { data, isLoading } = useMetrics();

  if (isLoading || !data) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="rounded-xl border border-slate-700 bg-slate-800/50 p-6 animate-pulse h-28" />
        ))}
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-lg font-semibold text-white mb-3">Live Metrics</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Tokens Created */}
        <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-5">
          <div className="flex items-center gap-2 text-slate-400 mb-2">
            <Hash className="w-4 h-4" />
            <span className="text-sm">Tokens Created</span>
          </div>
          <p className="text-3xl font-mono font-bold text-white">
            {data.total_tokens_created.toLocaleString()}
          </p>
        </div>

        {/* Crypto Latency */}
        <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-5">
          <div className="flex items-center gap-2 text-slate-400 mb-2">
            <Activity className="w-4 h-4" />
            <span className="text-sm">Crypto Latency (sum)</span>
          </div>
          <p className="text-3xl font-mono font-bold text-white">
            {data.crypto_latency.length > 0
              ? `${(data.crypto_latency[0].value * 1000).toFixed(1)}ms`
              : "N/A"}
          </p>
        </div>

        {/* Error Rate */}
        <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-5">
          <div className="flex items-center gap-2 text-slate-400 mb-2">
            <AlertCircle className="w-4 h-4" />
            <span className="text-sm">Total Errors</span>
          </div>
          <p className="text-3xl font-mono font-bold text-white">
            {data.error_rate.length > 0
              ? data.error_rate[0].value.toFixed(0)
              : "0"}
          </p>
        </div>
      </div>
    </div>
  );
}
