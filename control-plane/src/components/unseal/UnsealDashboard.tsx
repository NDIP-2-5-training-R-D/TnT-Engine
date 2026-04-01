"use client";

import { useState } from "react";
import { useSealStatus, submitUnsealShard, initializeVault } from "@/lib/api";
import type { InitResponse, Pkcs11ErrorInfo } from "@/lib/types";
import {
  Unlock, Lock, Loader2, AlertTriangle, ShieldCheck,
  Key, Copy, Eye, EyeOff, RefreshCw, Cpu,
} from "lucide-react";
import clsx from "clsx";

// ── Unseal Progress Bar ────────────────────────────────────────────

function UnsealProgress({ progress, threshold }: { progress: number; threshold: number }) {
  const pct = threshold > 0 ? Math.min((progress / threshold) * 100, 100) : 0;
  return (
    <div className="space-y-2">
      <div className="flex justify-between text-sm">
        <span className="text-slate-400">Unseal Progress</span>
        <span className="font-mono text-white">{progress} / {threshold} shards</span>
      </div>
      <div className="h-3 bg-slate-700 rounded-full overflow-hidden">
        <div
          className="h-full bg-vault-green rounded-full transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ── PKCS#11 Error Panel ────────────────────────────────────────────

function Pkcs11ErrorPanel({ error }: { error: Pkcs11ErrorInfo }) {
  return (
    <div className="rounded-lg border border-vault-red/40 bg-vault-red/10 p-4">
      <div className="flex items-center gap-2 mb-2">
        <Cpu className="w-5 h-5 text-vault-red" />
        <span className="font-mono font-bold text-vault-red">{error.code}</span>
      </div>
      <p className="text-sm text-white mb-1">{error.label}</p>
      <p className="text-xs text-slate-400">{error.suggestion}</p>
      <button
        onClick={() => window.location.reload()}
        className="mt-3 flex items-center gap-2 px-3 py-1.5 bg-slate-700 rounded text-xs text-slate-300 hover:bg-slate-600"
      >
        <RefreshCw className="w-3 h-3" /> Retry Connection
      </button>
    </div>
  );
}

// ── Shard Submit Form ──────────────────────────────────────────────

function ShardSubmitForm({ onSubmitted }: { onSubmitted: () => void }) {
  const [key, setKey] = useState("");
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const [pkcs11Error, setPkcs11Error] = useState<Pkcs11ErrorInfo | null>(null);

  const handleSubmit = async () => {
    setStatus("loading");
    setPkcs11Error(null);
    try {
      const res = await submitUnsealShard(key, reason);
      if (res.success) {
        setStatus("success");
        setMessage(res.message);
        setKey("");
        setReason("");
        onSubmitted();
        setTimeout(() => setStatus("idle"), 3000);
      } else {
        setStatus("error");
        setMessage(res.message);
        if (res.pkcs11_error) setPkcs11Error(res.pkcs11_error);
      }
    } catch (err) {
      setStatus("error");
      setMessage(String(err));
    }
  };

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Key className="w-5 h-5 text-vault-yellow" />
        <h3 className="font-semibold text-white">Submit Unseal Key Shard</h3>
      </div>

      <input
        type="password"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="Paste unseal key shard..."
        className="w-full px-4 py-2.5 bg-slate-900 border border-slate-600 rounded-lg text-white font-mono text-sm focus:border-vault-yellow focus:outline-none"
      />

      <input
        type="text"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason for unseal (required for audit)"
        className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg text-white text-sm focus:border-vault-yellow focus:outline-none"
      />

      <div className="flex items-center gap-3">
        <button
          onClick={handleSubmit}
          disabled={!key || !reason || reason.length < 3 || status === "loading"}
          className="flex items-center gap-2 px-4 py-2 bg-vault-yellow/20 border border-vault-yellow/40 rounded-lg text-vault-yellow font-medium text-sm disabled:opacity-30 hover:bg-vault-yellow/30 transition-colors"
        >
          {status === "loading" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Unlock className="w-4 h-4" />}
          Submit Shard
        </button>
        {message && (
          <span className={clsx("text-sm", status === "success" ? "text-vault-green" : "text-vault-red")}>
            {message}
          </span>
        )}
      </div>

      {pkcs11Error && <Pkcs11ErrorPanel error={pkcs11Error} />}
    </div>
  );
}

// ── Init Form (for uninitialized vaults) ───────────────────────────

function InitForm() {
  const [shares, setShares] = useState(1);
  const [threshold, setThreshold] = useState(1);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [result, setResult] = useState<InitResponse | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  const [copied, setCopied] = useState("");

  const handleInit = async () => {
    setStatus("loading");
    try {
      const res = await initializeVault(shares, threshold);
      if (res.success) {
        setStatus("done");
        setResult(res);
      } else {
        setStatus("error");
        setResult(res);
      }
    } catch {
      setStatus("error");
    }
  };

  const copyValue = (val: string, label: string) => {
    navigator.clipboard.writeText(val);
    setCopied(label);
    setTimeout(() => setCopied(""), 2000);
  };

  if (status === "done" && result) {
    return (
      <div className="rounded-xl border-2 border-vault-yellow/40 bg-vault-yellow/5 p-5 space-y-4">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-6 h-6 text-vault-yellow" />
          <h3 className="font-bold text-vault-yellow">SAVE THESE CREDENTIALS NOW</h3>
        </div>
        <p className="text-sm text-slate-300">These will NOT be shown again. Store them in a secure vault or password manager.</p>

        {/* Root Token */}
        <div className="space-y-1">
          <label className="text-xs text-slate-500">Root Token</label>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-3 py-2 bg-slate-900 rounded font-mono text-sm text-white overflow-auto">
              {showKeys ? result.root_token : "••••••••••••••••••••••••••"}
            </code>
            <button onClick={() => copyValue(result.root_token!, "root")} className="text-slate-400 hover:text-white"><Copy className="w-4 h-4" /></button>
          </div>
          {copied === "root" && <span className="text-xs text-vault-green">Copied!</span>}
        </div>

        {/* Unseal Keys */}
        <div className="space-y-1">
          <label className="text-xs text-slate-500">Unseal Keys ({result.unseal_keys?.length})</label>
          {result.unseal_keys?.map((k, i) => (
            <div key={i} className="flex items-center gap-2">
              <code className="flex-1 px-3 py-1.5 bg-slate-900 rounded font-mono text-xs text-white overflow-auto">
                {showKeys ? k : `••••••••••••-shard-${i + 1}`}
              </code>
              <button onClick={() => copyValue(k, `key-${i}`)} className="text-slate-400 hover:text-white"><Copy className="w-3.5 h-3.5" /></button>
              {copied === `key-${i}` && <span className="text-xs text-vault-green">Copied</span>}
            </div>
          ))}
        </div>

        <button
          onClick={() => setShowKeys(!showKeys)}
          className="flex items-center gap-2 text-sm text-slate-400 hover:text-white"
        >
          {showKeys ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          {showKeys ? "Hide" : "Reveal"} credentials
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-5 space-y-4">
      <h3 className="font-semibold text-white">Initialize Vault</h3>
      <p className="text-sm text-slate-400">This vault has not been initialized yet. Configure key sharing parameters.</p>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-xs text-slate-500 block mb-1">Key Shares (n)</label>
          <input type="number" value={shares} min={1} max={10} onChange={(e) => setShares(+e.target.value)}
            className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded text-white font-mono focus:outline-none" />
        </div>
        <div>
          <label className="text-xs text-slate-500 block mb-1">Threshold (t)</label>
          <input type="number" value={threshold} min={1} max={shares} onChange={(e) => setThreshold(+e.target.value)}
            className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded text-white font-mono focus:outline-none" />
        </div>
      </div>
      <button
        onClick={handleInit}
        disabled={status === "loading" || threshold > shares}
        className="flex items-center gap-2 px-4 py-2 bg-vault-green/20 border border-vault-green/40 rounded-lg text-vault-green font-medium disabled:opacity-30"
      >
        {status === "loading" ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
        Initialize Vault
      </button>
      {status === "error" && <p className="text-sm text-vault-red">{result?.message ?? "Init failed"}</p>}
    </div>
  );
}

// ── Main Unseal Dashboard ──────────────────────────────────────────

export default function UnsealDashboard() {
  const { data, mutate, isLoading } = useSealStatus();

  if (isLoading) {
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-8 text-center">
        <Loader2 className="w-8 h-8 text-slate-500 animate-spin mx-auto mb-2" />
        <p className="text-slate-500">Connecting to OpenBao...</p>
      </div>
    );
  }

  // Uninitialized
  if (data && !data.initialized) {
    return <InitForm />;
  }

  // Unsealed (healthy)
  if (data && !data.sealed) {
    return (
      <div className="rounded-xl border border-vault-green/30 bg-vault-green/5 p-5">
        <div className="flex items-center gap-3">
          <ShieldCheck className="w-8 h-8 text-vault-green" />
          <div>
            <p className="text-lg font-bold text-vault-green">Vault is Unsealed</p>
            <p className="text-sm text-slate-400">
              Seal type: <span className="font-mono">{data.seal_type}</span> | Version: {data.version}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Sealed — show unseal interface
  return (
    <div className="space-y-4">
      {/* Status header */}
      <div className="rounded-xl border border-vault-red/30 bg-vault-red/5 p-5">
        <div className="flex items-center gap-3 mb-4">
          <Lock className="w-8 h-8 text-vault-red" />
          <div>
            <p className="text-lg font-bold text-vault-red">Vault is SEALED</p>
            <p className="text-sm text-slate-400">
              Seal type: <span className="font-mono">{data?.seal_type ?? "unknown"}</span>
              {data?.seal_type === "pkcs11" && " (PKCS#11/HSM)"}
            </p>
          </div>
          <button onClick={() => mutate()} className="ml-auto text-slate-500 hover:text-white">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
        {data && <UnsealProgress progress={data.progress} threshold={data.threshold} />}
      </div>

      {/* PKCS#11 error */}
      {data?.pkcs11_error && <Pkcs11ErrorPanel error={data.pkcs11_error} />}

      {/* Shard submission */}
      {data?.seal_type === "shamir" && (
        <ShardSubmitForm onSubmitted={() => mutate()} />
      )}

      {data?.seal_type === "pkcs11" && (
        <div className="rounded-xl border border-vault-yellow/30 bg-vault-yellow/5 p-5">
          <div className="flex items-center gap-2 mb-2">
            <Cpu className="w-5 h-5 text-vault-yellow" />
            <h3 className="font-semibold text-vault-yellow">PKCS#11 Auto-Unseal</h3>
          </div>
          <p className="text-sm text-slate-400">
            This vault uses PKCS#11 seal. Auto-unseal should happen automatically when the HSM is accessible.
            If the vault remains sealed, check the HSM connection and PIN configuration.
          </p>
          <button
            onClick={() => mutate()}
            className="mt-3 flex items-center gap-2 px-3 py-1.5 bg-vault-yellow/20 border border-vault-yellow/40 rounded text-vault-yellow text-sm"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Check Status
          </button>
        </div>
      )}

      {/* Error state */}
      {data?.error && !data?.pkcs11_error && (
        <div className="rounded-lg border border-vault-red/30 bg-vault-red/5 p-4 text-sm text-vault-red">
          {data.error}
        </div>
      )}
    </div>
  );
}
