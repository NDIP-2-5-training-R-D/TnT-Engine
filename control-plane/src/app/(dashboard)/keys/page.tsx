"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useTransitKeys, rotateKey, downloadBackup } from "@/lib/api";
import type { TransitKeyInfo } from "@/lib/types";
import { Key, RotateCw, Download, ShieldCheck, AlertTriangle, Loader2 } from "lucide-react";
import clsx from "clsx";

function RotateConfirm({ keyName, onDone }: { keyName: string; onDone: () => void }) {
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  const expected = keyName;

  const handleRotate = async () => {
    setStatus("loading");
    try {
      const res = await rotateKey(keyName);
      setStatus(res.success ? "done" : "error");
      setMessage(res.message);
    } catch (e) {
      setStatus("error");
      setMessage(String(e));
    }
  };

  if (status === "done" || status === "error") {
    return (
      <div className={clsx("p-3 rounded-lg text-sm", status === "done" ? "bg-vault-green/10 text-vault-green" : "bg-vault-red/10 text-vault-red")}>
        <p>{message}</p>
        <button onClick={onDone} className="mt-2 text-xs underline">Dismiss</button>
      </div>
    );
  }

  return (
    <div className="p-3 bg-slate-800 rounded-lg border border-slate-600 space-y-2">
      <p className="text-xs text-slate-400">
        Type <code className="text-vault-yellow font-mono">{expected}</code> to confirm rotation:
      </p>
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        className="w-full px-3 py-1.5 bg-slate-900 border border-slate-600 rounded text-sm font-mono text-white focus:border-vault-yellow focus:outline-none"
        placeholder={expected}
      />
      <div className="flex gap-2">
        <button onClick={onDone} className="px-3 py-1 bg-slate-700 rounded text-xs text-slate-300">Cancel</button>
        <button
          onClick={handleRotate}
          disabled={input !== expected || status === "loading"}
          className="px-3 py-1 bg-vault-yellow/20 border border-vault-yellow/40 rounded text-xs text-vault-yellow font-medium disabled:opacity-30"
        >
          {status === "loading" ? <Loader2 className="w-3 h-3 animate-spin inline" /> : "Rotate"}
        </button>
      </div>
    </div>
  );
}

function KeyCard({ k, canWrite, onRefresh }: { k: TransitKeyInfo; canWrite: boolean; onRefresh: () => void }) {
  const [showRotate, setShowRotate] = useState(false);

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Key className="w-5 h-5 text-vault-blue" />
          <h3 className="font-mono font-bold text-white">{k.name}</h3>
        </div>
        <span className="text-xs px-2 py-0.5 bg-slate-700 rounded text-slate-400">{k.type}</span>
      </div>
      <div className="grid grid-cols-2 gap-y-2 text-sm mb-4">
        <div><span className="text-slate-500">Version:</span> <span className="text-white font-mono">{k.latest_version}</span></div>
        <div><span className="text-slate-500">Min Decrypt:</span> <span className="text-white font-mono">{k.min_decryption_version}</span></div>
        <div><span className="text-slate-500">Encrypt:</span> <span className={k.supports_encryption ? "text-vault-green" : "text-slate-600"}>{k.supports_encryption ? "Yes" : "No"}</span></div>
        <div><span className="text-slate-500">Deletable:</span> <span className={k.deletion_allowed ? "text-vault-red" : "text-vault-green"}>{k.deletion_allowed ? "Yes" : "No"}</span></div>
      </div>
      {canWrite && (showRotate ? (
        <RotateConfirm keyName={k.name} onDone={() => { setShowRotate(false); onRefresh(); }} />
      ) : (
        <button
          onClick={() => setShowRotate(true)}
          className="flex items-center gap-2 px-3 py-1.5 bg-vault-yellow/10 border border-vault-yellow/30 rounded-lg text-vault-yellow text-sm hover:bg-vault-yellow/20 transition-colors"
        >
          <RotateCw className="w-3.5 h-3.5" /> Rotate Key
        </button>
      ))}
    </div>
  );
}

export default function KeysPage() {
  const { data: session } = useSession();
  const role = (session?.user as { role?: string })?.role ?? "requester";
  const canWrite = role === "admin" || role === "manager";

  const { data, isLoading, mutate } = useTransitKeys();
  const [backupStatus, setBackupStatus] = useState<"idle" | "loading" | "done" | "error">("idle");

  const handleBackup = async () => {
    setBackupStatus("loading");
    try {
      const blob = await downloadBackup();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `vault_raft_${new Date().toISOString().replace(/[:.]/g, "-")}.snap`;
      a.click();
      URL.revokeObjectURL(url);
      setBackupStatus("done");
      setTimeout(() => setBackupStatus("idle"), 3000);
    } catch {
      setBackupStatus("error");
      setTimeout(() => setBackupStatus("idle"), 3000);
    }
  };

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <ShieldCheck className="w-6 h-6 text-vault-blue" />
          <h1 className="text-xl font-bold text-white">Key Lifecycle Management</h1>
        </div>
        {canWrite && (
          <button
            onClick={handleBackup}
            disabled={backupStatus === "loading"}
            className="flex items-center gap-2 px-4 py-2 bg-slate-700 border border-slate-600 rounded-lg text-sm text-slate-300 hover:bg-slate-600 transition-colors disabled:opacity-50"
          >
            {backupStatus === "loading" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {backupStatus === "done" ? "Downloaded!" : backupStatus === "error" ? "Failed" : "Raft Backup"}
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[1, 2].map((i) => <div key={i} className="rounded-xl border border-slate-700 bg-slate-800/50 p-5 h-40 animate-pulse" />)}
        </div>
      ) : !data || data.length === 0 ? (
        <div className="rounded-xl border border-slate-700 bg-slate-800/30 p-8 text-center text-slate-500">
          <AlertTriangle className="w-8 h-8 mx-auto mb-2 text-vault-yellow" />
          <p>No transit keys found. Initialize OpenBao transit engine first.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {data.map((k) => <KeyCard key={k.name} k={k} canWrite={canWrite} onRefresh={() => mutate()} />)}
        </div>
      )}
    </div>
  );
}
