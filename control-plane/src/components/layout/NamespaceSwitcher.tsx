"use client";

import { useState } from "react";
import { useNamespace } from "@/lib/namespace-context";
import { Layers, Plus, Check, X } from "lucide-react";

export default function NamespaceSwitcher() {
  const { namespace, setNamespace, namespaces, refresh } = useNamespace();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;

    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/namespaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();

      if (!res.ok) {
        // Enterprise-only: give a clear, actionable message
        if (data.code === "ENTERPRISE_ONLY") {
          setError("Requires OpenBao or Vault Enterprise. OSS Vault does not support namespaces.");
        } else if (data.code === "VAULT_UNREACHABLE") {
          setError("Vault server is unreachable. Check VAULT_ADDR.");
        } else {
          setError(data.error ?? "Failed to create namespace");
        }
        return;
      }

      // Reload namespace list then switch to the newly created one
      await refresh();
      setNamespace(data.namespace);
      setCreating(false);
      setNewName("");
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  function handleCancel() {
    setCreating(false);
    setNewName("");
    setError("");
  }

  return (
    <div className="px-4 py-2 border-b border-slate-700">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <Layers className="w-3.5 h-3.5 text-slate-500" />
          <span className="text-[10px] text-slate-500 uppercase tracking-wider">Namespace</span>
        </div>
        {!creating && (
          <button
            onClick={() => setCreating(true)}
            title="Create new namespace (requires OpenBao or Vault Enterprise)"
            className="flex items-center gap-1 text-slate-400 hover:text-white transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="text-[9px] text-indigo-400 font-mono leading-none">OpenBao</span>
          </button>
        )}
      </div>

      {/* Dropdown — existing namespaces */}
      <select
        value={namespace}
        onChange={(e) => setNamespace(e.target.value)}
        className="w-full px-2 py-1.5 bg-slate-800 border border-slate-600 rounded text-sm text-white font-mono focus:border-vault-blue focus:outline-none"
      >
        {namespaces.map((ns) => (
          <option key={ns} value={ns}>
            {ns === "root" ? "root (default)" : ns}
          </option>
        ))}
      </select>

      {/* Inline form — create new namespace */}
      {creating && (
        <div className="mt-2 space-y-1">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
              if (e.key === "Escape") handleCancel();
            }}
            placeholder="new-namespace"
            disabled={loading}
            className="w-full px-2 py-1 bg-slate-900 border border-slate-500 rounded text-xs text-white font-mono placeholder-slate-600 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
          />
          {error && (
            <p className="text-red-400 text-[10px] leading-tight">{error}</p>
          )}
          <div className="flex gap-1">
            <button
              onClick={handleCreate}
              disabled={loading || !newName.trim()}
              className="flex-1 flex items-center justify-center gap-1 px-2 py-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed rounded text-xs text-white transition-colors"
            >
              <Check className="w-3 h-3" />
              {loading ? "Creating…" : "Create"}
            </button>
            <button
              onClick={handleCancel}
              disabled={loading}
              className="px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded text-xs text-white transition-colors"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
