"use client";

import { useState, useEffect } from "react";
import { useAppRoles, generateSecretId } from "@/lib/api";
import type { AppRoleInfo, SecretIdResponse } from "@/lib/types";
import { UserPlus, KeyRound, Shield, Copy, Eye, EyeOff, Loader2, Clock } from "lucide-react";
import clsx from "clsx";

function SecretIdReveal({ roleName }: { roleName: string }) {
  const [status, setStatus] = useState<"idle" | "loading" | "revealed" | "masked" | "error">("idle");
  const [secretData, setSecretData] = useState<SecretIdResponse | null>(null);
  const [timer, setTimer] = useState(30);
  const [copied, setCopied] = useState(false);

  // Auto-mask after 30 seconds
  useEffect(() => {
    if (status !== "revealed") return;
    if (timer <= 0) { setStatus("masked"); return; }
    const t = setTimeout(() => setTimer((v) => v - 1), 1000);
    return () => clearTimeout(t);
  }, [status, timer]);

  const handleGenerate = async () => {
    setStatus("loading");
    try {
      const res = await generateSecretId(roleName);
      if (res.secret_id) {
        setSecretData(res);
        setStatus("revealed");
        setTimer(30);
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  };

  const handleCopy = () => {
    if (secretData?.secret_id) {
      navigator.clipboard.writeText(secretData.secret_id);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (status === "idle") {
    return (
      <button onClick={handleGenerate} className="flex items-center gap-2 px-3 py-1.5 bg-vault-green/10 border border-vault-green/30 rounded-lg text-vault-green text-sm hover:bg-vault-green/20">
        <KeyRound className="w-3.5 h-3.5" /> Generate Secret ID
      </button>
    );
  }

  if (status === "loading") {
    return <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /> Generating...</div>;
  }

  if (status === "error") {
    return <div className="text-sm text-vault-red">Failed to generate. <button onClick={() => setStatus("idle")} className="underline">Retry</button></div>;
  }

  // Revealed or masked
  return (
    <div className="p-3 bg-slate-900 rounded-lg border border-slate-700 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-500">Secret ID {status === "masked" ? "(masked)" : ""}</span>
        {status === "revealed" && (
          <span className="flex items-center gap-1 text-xs text-vault-yellow"><Clock className="w-3 h-3" /> {timer}s</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <code className="flex-1 text-sm font-mono bg-slate-800 px-2 py-1 rounded text-white overflow-hidden">
          {status === "revealed" ? secretData?.secret_id : "••••••••-••••-••••-••••-••••••••••••"}
        </code>
        {status === "revealed" && (
          <button onClick={handleCopy} className="text-slate-400 hover:text-white">
            <Copy className="w-4 h-4" />
          </button>
        )}
      </div>
      {copied && <p className="text-xs text-vault-green">Copied!</p>}
      {secretData?.secret_id_accessor && (
        <p className="text-xs text-slate-600">Accessor: {secretData.secret_id_accessor}</p>
      )}
      <button onClick={() => setStatus("idle")} className="text-xs text-slate-500 hover:text-white">Generate Another</button>
    </div>
  );
}

function RoleCard({ role }: { role: AppRoleInfo }) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-vault-green" />
          <h3 className="font-mono font-bold text-white">{role.role_name}</h3>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-y-1 text-sm">
        <div><span className="text-slate-500">TTL:</span> <span className="text-white font-mono">{role.token_ttl ? `${role.token_ttl / 3600}h` : "default"}</span></div>
        <div><span className="text-slate-500">Max TTL:</span> <span className="text-white font-mono">{role.token_max_ttl ? `${role.token_max_ttl / 3600}h` : "default"}</span></div>
      </div>
      {role.token_policies.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {role.token_policies.map((p) => (
            <span key={p} className="px-2 py-0.5 bg-slate-700 rounded text-xs font-mono text-slate-300">{p}</span>
          ))}
        </div>
      )}
      <SecretIdReveal roleName={role.role_name} />
    </div>
  );
}

export default function AppRolesPage() {
  const { data, isLoading } = useAppRoles();

  return (
    <div className="max-w-5xl">
      <div className="flex items-center gap-3 mb-6">
        <UserPlus className="w-6 h-6 text-vault-green" />
        <h1 className="text-xl font-bold text-white">AppRole Provisioning</h1>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[1, 2].map((i) => <div key={i} className="rounded-xl border border-slate-700 bg-slate-800/50 h-48 animate-pulse" />)}
        </div>
      ) : !data || data.length === 0 ? (
        <div className="rounded-xl border border-slate-700 bg-slate-800/30 p-8 text-center text-slate-500">
          No AppRoles found. Create one via Terraform or the OpenBao CLI.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {data.map((role) => <RoleCard key={role.role_name} role={role} />)}
        </div>
      )}
    </div>
  );
}
