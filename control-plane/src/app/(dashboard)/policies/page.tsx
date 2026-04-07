"use client";

import { useState } from "react";
import { usePolicies, usePolicy, savePolicy } from "@/lib/api";
import { FileCode, Plus, Save, Loader2, Eye, Trash2 } from "lucide-react";
import clsx from "clsx";

const CAPABILITY_OPTIONS = ["create", "read", "update", "delete", "list"];

interface RuleRow {
  path: string;
  capabilities: string[];
}

function PolicyBuilder({ onSaved }: { onSaved: () => void }) {
  const [name, setName] = useState("");
  const [rules, setRules] = useState<RuleRow[]>([{ path: "", capabilities: [] }]);
  const [status, setStatus] = useState<"idle" | "saving" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  const addRule = () => setRules([...rules, { path: "", capabilities: [] }]);
  const removeRule = (i: number) => setRules(rules.filter((_, idx) => idx !== i));

  const toggleCap = (ruleIdx: number, cap: string) => {
    setRules(rules.map((r, i) => {
      if (i !== ruleIdx) return r;
      const caps = r.capabilities.includes(cap) ? r.capabilities.filter((c) => c !== cap) : [...r.capabilities, cap];
      return { ...r, capabilities: caps };
    }));
  };

  const handleSave = async () => {
    if (!name || rules.every((r) => !r.path)) return;
    setStatus("saving");
    try {
      const res = await savePolicy(name, rules.filter((r) => r.path && r.capabilities.length > 0));
      setStatus(res.success ? "done" : "error");
      setMessage(res.message);
      if (res.success) { setTimeout(() => { onSaved(); setStatus("idle"); }, 1500); }
    } catch (e) {
      setStatus("error");
      setMessage(String(e));
    }
  };

  // HCL preview
  const preview = rules.filter((r) => r.path && r.capabilities.length > 0)
    .map((r) => `path "${r.path}" {\n  capabilities = [${r.capabilities.map((c) => `"${c}"`).join(", ")}]\n}`)
    .join("\n\n");

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-5 space-y-4">
      <h3 className="text-sm font-semibold text-white flex items-center gap-2"><Plus className="w-4 h-4" /> New Policy</h3>
      <input
        value={name}
        onChange={(e) => setName(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ""))}
        placeholder="Policy name (e.g., my-service-transit)"
        className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded-lg text-sm text-white font-mono focus:border-vault-blue focus:outline-none"
      />

      {rules.map((rule, i) => (
        <div key={i} className="flex gap-2 items-start">
          <input
            value={rule.path}
            onChange={(e) => setRules(rules.map((r, idx) => idx === i ? { ...r, path: e.target.value } : r))}
            placeholder="transit/encrypt/my-key"
            className="flex-1 px-3 py-1.5 bg-slate-900 border border-slate-600 rounded text-sm font-mono text-white focus:outline-none"
          />
          <div className="flex gap-1 flex-wrap">
            {CAPABILITY_OPTIONS.map((cap) => (
              <button
                key={cap}
                onClick={() => toggleCap(i, cap)}
                className={clsx("px-2 py-1 rounded text-xs font-mono", rule.capabilities.includes(cap)
                  ? "bg-vault-blue/20 text-vault-blue border border-vault-blue/40"
                  : "bg-slate-700 text-slate-500 border border-slate-600"
                )}
              >{cap}</button>
            ))}
          </div>
          {rules.length > 1 && (
            <button onClick={() => removeRule(i)} className="text-slate-600 hover:text-vault-red"><Trash2 className="w-4 h-4" /></button>
          )}
        </div>
      ))}

      <button onClick={addRule} className="text-xs text-vault-blue hover:underline">+ Add path rule</button>

      {/* HCL Preview */}
      {preview && (
        <div className="rounded-lg bg-slate-900 p-3 border border-slate-700">
          <div className="flex items-center gap-1 text-xs text-slate-500 mb-2"><Eye className="w-3 h-3" /> HCL Preview</div>
          <pre className="text-xs text-vault-green font-mono whitespace-pre-wrap">{preview}</pre>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={!name || status === "saving" || rules.every((r) => !r.path || r.capabilities.length === 0)}
          className="flex items-center gap-2 px-4 py-2 bg-vault-blue/20 border border-vault-blue/40 rounded-lg text-vault-blue text-sm font-medium disabled:opacity-30"
        >
          {status === "saving" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Save Policy
        </button>
        {message && <span className={clsx("text-xs", status === "done" ? "text-vault-green" : "text-vault-red")}>{message}</span>}
      </div>
    </div>
  );
}

export default function PoliciesPage() {
  const { data, isLoading, mutate } = usePolicies();
  const [selectedPolicy, setSelectedPolicy] = useState<string | null>(null);
  const { data: policyDetail } = usePolicy(selectedPolicy || "");

  return (
    <div className="max-w-5xl">
      <div className="flex items-center gap-3 mb-6">
        <FileCode className="w-6 h-6 text-vault-blue" />
        <h1 className="text-xl font-bold text-white">Policy Builder</h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Policy List */}
        <div className="lg:col-span-1">
          <h2 className="text-sm font-semibold text-slate-400 mb-3">Existing Policies</h2>
          <div className="space-y-1">
            {isLoading ? (
              <div className="text-sm text-slate-500">Loading...</div>
            ) : data?.map((p) => (
              <button
                key={p.name}
                onClick={() => setSelectedPolicy(p.name)}
                className={clsx("w-full text-left px-3 py-2 rounded-lg text-sm font-mono transition-colors",
                  selectedPolicy === p.name ? "bg-slate-700 text-white" : "text-slate-400 hover:bg-slate-800 hover:text-white"
                )}
              >{p.name}</button>
            ))}
          </div>
          {/* Policy detail */}
          {policyDetail?.rules && (
            <div className="mt-4 rounded-lg bg-slate-900 p-3 border border-slate-700">
              <p className="text-xs text-slate-500 mb-1">{selectedPolicy}</p>
              <pre className="text-xs text-slate-300 font-mono whitespace-pre-wrap max-h-64 overflow-auto">{policyDetail.rules}</pre>
            </div>
          )}
        </div>

        {/* Policy Builder */}
        <div className="lg:col-span-2">
          <PolicyBuilder onSaved={() => mutate()} />
        </div>
      </div>
    </div>
  );
}
