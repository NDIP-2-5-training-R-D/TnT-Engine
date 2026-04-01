"use client";

import { useHealth } from "@/lib/api";
import StatusCard from "./StatusCard";
import { RefreshCw } from "lucide-react";

export default function HealthMap() {
  const { data, error, isLoading, mutate } = useHealth();

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="rounded-xl border border-slate-700 bg-slate-800 p-4 animate-pulse h-32" />
        ))}
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-xl border border-vault-red/30 bg-vault-red/5 p-6 text-center">
        <p className="text-vault-red font-medium">Failed to fetch health status</p>
        <button onClick={() => mutate()} className="mt-2 text-sm text-slate-400 hover:text-white">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-white">Infrastructure Health</h2>
        <button onClick={() => mutate()} className="text-slate-500 hover:text-white transition-colors">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatusCard
          title="OpenBao Vault"
          status={data.vault.status}
          details={data.vault.version ? `v${data.vault.version}` : undefined}
        />
        <StatusCard
          title="T&T Engine"
          status={data.engine.status}
          details={`Circuit: ${data.engine.circuit_breaker}`}
          metric={data.engine.l1_cache_size}
          metricLabel="L1 entries"
        />
        <StatusCard
          title="PostgreSQL"
          status={data.postgres.connected ? "connected" : "disconnected"}
        />
        <StatusCard
          title="Redis Cache"
          status={data.redis.connected ? "connected" : "disconnected"}
        />
      </div>
    </div>
  );
}
