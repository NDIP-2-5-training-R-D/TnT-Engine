"use client";

import HealthMap from "@/components/health/HealthMap";
import MetricsPanel from "@/components/metrics/CryptoLatencyChart";

export default function Dashboard() {
  return (
    <div className="space-y-6 max-w-7xl">
      {/* Health Map — auto-refreshes every 5s */}
      <HealthMap />

      {/* Metrics — auto-refreshes every 15s */}
      <MetricsPanel />

      {/* Timestamp */}
      <p className="text-xs text-slate-600 text-right">
        Auto-refreshing. Health: 5s | Metrics: 15s
      </p>
    </div>
  );
}
