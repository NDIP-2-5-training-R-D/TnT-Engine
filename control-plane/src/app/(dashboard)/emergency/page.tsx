"use client";

import SealButton from "@/components/emergency/SealButton";
import UnsealDashboard from "@/components/unseal/UnsealDashboard";
import { useHealth, useHsmStatus } from "@/lib/api";
import { ShieldAlert, Cpu, Lock, Unlock } from "lucide-react";
import clsx from "clsx";

export default function EmergencyPage() {
  const { data } = useHealth();
  const { data: hsmData } = useHsmStatus();
  const isSealed = data?.vault?.sealed ?? false;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <ShieldAlert className="w-6 h-6 text-vault-red" />
        <h1 className="text-xl font-bold text-white">Emergency & Operations Center</h1>
      </div>

      {/* HSM Status Card */}
      {hsmData && (
        <div className={clsx(
          "rounded-xl border p-4",
          hsmData.status === "healthy" ? "border-vault-green/30 bg-vault-green/5" :
          hsmData.status === "error" ? "border-vault-red/30 bg-vault-red/5" :
          "border-slate-700 bg-slate-800/50"
        )}>
          <div className="flex items-center gap-3">
            <Cpu className={clsx("w-6 h-6",
              hsmData.status === "healthy" ? "text-vault-green" :
              hsmData.status === "error" ? "text-vault-red" : "text-slate-400"
            )} />
            <div>
              <p className="text-sm font-semibold text-white">
                HSM: <span className="font-mono">{hsmData.seal_type.toUpperCase()}</span>
              </p>
              <p className="text-xs text-slate-400">{hsmData.message}</p>
            </div>
          </div>
          {hsmData.pkcs11_error && (
            <div className="mt-3 p-3 rounded-lg bg-vault-red/10 border border-vault-red/30">
              <p className="font-mono text-sm text-vault-red">{hsmData.pkcs11_error.code}</p>
              <p className="text-xs text-slate-300 mt-1">{hsmData.pkcs11_error.label}</p>
              <p className="text-xs text-slate-500 mt-0.5">{hsmData.pkcs11_error.suggestion}</p>
            </div>
          )}
        </div>
      )}

      {/* Unseal / Init Dashboard */}
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-300 mb-3">
          {isSealed ? <Lock className="w-4 h-4 text-vault-red" /> : <Unlock className="w-4 h-4 text-vault-green" />}
          Unseal Status
        </h2>
        <UnsealDashboard />
      </div>

      {/* Emergency Seal */}
      {!isSealed && (
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-300 mb-3">
            <ShieldAlert className="w-4 h-4 text-vault-red" />
            Emergency Seal
          </h2>
          <SealButton />
        </div>
      )}

      {/* Impact Reference */}
      <div className="rounded-xl border border-slate-700 bg-slate-800/30 p-4">
        <h3 className="text-sm font-semibold text-slate-300 mb-2">Seal/Unseal Impact Reference</h3>
        <div className="grid grid-cols-2 gap-4 text-xs text-slate-500">
          <div>
            <p className="font-semibold text-vault-red mb-1">When SEALED:</p>
            <ul className="space-y-0.5 list-disc list-inside">
              <li>Tokenize/detokenize returns 503</li>
              <li>Circuit breaker opens</li>
              <li>K8s readiness fails</li>
              <li>Audit buffer continues</li>
            </ul>
          </div>
          <div>
            <p className="font-semibold text-vault-green mb-1">When UNSEALED:</p>
            <ul className="space-y-0.5 list-disc list-inside">
              <li>Crypto operations resume</li>
              <li>Circuit breaker auto-closes (30s)</li>
              <li>K8s routes traffic back</li>
              <li>Audit DLQ auto-replayed</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
