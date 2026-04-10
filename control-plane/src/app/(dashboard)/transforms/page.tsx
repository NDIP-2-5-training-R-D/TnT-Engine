"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "next-auth/react";
import {
  Wand2, ArrowRight, Wifi, WifiOff, RefreshCw,
  ShieldAlert, Shield, ShieldCheck,
  Plus, Pencil, Trash2, X, Check, AlertTriangle,
} from "lucide-react";
import clsx from "clsx";
import type {
  TransformRule,
  TransformRulesResponse,
  SensitivityLevel,
  RuleUpsertRequest,
} from "@/lib/types";

// ── Classification display config ──────────────────────────────────

const LEVEL_CONFIG: Record<SensitivityLevel, {
  label: string;
  badge: string;
  border: string;
  icon: typeof ShieldAlert;
  opColor: string;
}> = {
  HIGH_SENSITIVE: {
    label: "HIGH",
    badge: "bg-red-500/20 text-red-300 border border-red-500/30",
    border: "border-red-500/20",
    icon: ShieldAlert,
    opColor: "bg-red-500/10 text-red-400",
  },
  MEDIUM: {
    label: "MEDIUM",
    badge: "bg-yellow-500/20 text-yellow-300 border border-yellow-500/30",
    border: "border-yellow-500/20",
    icon: Shield,
    opColor: "bg-yellow-500/10 text-yellow-400",
  },
  LOW: {
    label: "LOW",
    badge: "bg-green-500/20 text-green-300 border border-green-500/30",
    border: "border-slate-700",
    icon: ShieldCheck,
    opColor: "bg-green-500/10 text-green-400",
  },
  UNCLASSIFIED: {
    label: "UNCLASSIFIED",
    badge: "bg-slate-500/20 text-slate-400 border border-slate-500/30",
    border: "border-slate-700",
    icon: Shield,
    opColor: "bg-slate-500/10 text-slate-400",
  },
};

const TYPE_BADGE: Record<string, string> = {
  fpe: "bg-purple-500/20 text-purple-300",
  masking: "bg-blue-500/20 text-blue-300",
  hash: "bg-cyan-500/20 text-cyan-300",
};

const SECTION_ORDER: SensitivityLevel[] = ["HIGH_SENSITIVE", "MEDIUM", "LOW", "UNCLASSIFIED"];

const ALL_OPS = ["TOKENIZE", "MASK", "HMAC", "HASH", "PASSTHROUGH"] as const;

function groupByClassification(rules: TransformRule[]): Record<string, TransformRule[]> {
  return rules.reduce<Record<string, TransformRule[]>>((acc, rule) => {
    const key = rule.classification ?? "UNCLASSIFIED";
    if (!acc[key]) acc[key] = [];
    acc[key].push(rule);
    return acc;
  }, {});
}

// ── Blank form ─────────────────────────────────────────────────────

const BLANK_FORM: RuleUpsertRequest = {
  name: "",
  type: "masking",
  template: "",
  tweak_source: "internal",
  allowed_roles: ["tnt-engine"],
  classification: "MEDIUM",
  allowed_operations: ["TOKENIZE"],
  description: "",
  retention_days: null,
};

// ── Rule Form Modal ────────────────────────────────────────────────

function RuleFormModal({
  initial,
  isEdit,
  approvalMode,
  onClose,
  onSaved,
}: {
  initial: RuleUpsertRequest;
  isEdit: boolean;
  approvalMode: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<RuleUpsertRequest>(initial);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const set = <K extends keyof RuleUpsertRequest>(k: K, v: RuleUpsertRequest[K]) =>
    setForm((prev) => ({ ...prev, [k]: v }));

  const toggleOp = (op: string) => {
    const ops = form.allowed_operations.includes(op)
      ? form.allowed_operations.filter((o) => o !== op)
      : [...form.allowed_operations, op];
    set("allowed_operations", ops);
  };

  const handleSubmit = async () => {
    if (!form.name.trim()) { setError("Field name is required"); return; }
    if (form.allowed_operations.length === 0) { setError("Select at least one operation"); return; }
    if (approvalMode && !reason.trim()) { setError("Reason is required for approval requests"); return; }
    setSaving(true);
    setError(null);
    try {
      if (approvalMode) {
        // Submit approval request instead of direct API call
        const action = isEdit ? "RULE_UPDATE" : "RULE_CREATE";
        const res = await fetch("/api/approvals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operation: "create",
            action,
            target: form.name || initial.name,
            reason: reason.trim(),
            payload: form,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "Failed to submit request");
          return;
        }
        setSubmitted(true);
        setTimeout(onClose, 2000);
      } else {
        // Direct execution (admin / manager)
        const url = isEdit ? `/api/transforms/${encodeURIComponent(initial.name)}` : "/api/transforms";
        const res = await fetch(url, {
          method: isEdit ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        });
        const data = await res.json();
        if (!res.ok) {
          const detail = data.detail ?? data.error ?? "Unknown error";
          setError(typeof detail === "string" ? detail : JSON.stringify(detail));
          return;
        }
        onSaved();
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-6 mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-white">
            {approvalMode
              ? (isEdit ? "Request Rule Edit" : "Request New Rule")
              : (isEdit ? "Edit Rule" : "New Transform Rule")}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {submitted ? (
          <div className="py-6 text-center">
            <Check className="w-10 h-10 text-vault-green mx-auto mb-3" />
            <p className="text-vault-green font-medium">Request submitted for manager approval</p>
            <p className="text-xs text-slate-500 mt-1">You can track it in the Approvals page.</p>
          </div>
        ) : (
        <>
        <div className="space-y-4">
          {/* Field name */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">Field name</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => set("name", e.target.value.toLowerCase().replace(/\s+/g, "_"))}
              disabled={isEdit}
              placeholder="e.g. national_id"
              className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white font-mono placeholder:text-slate-600 focus:outline-none focus:border-purple-500 disabled:opacity-50 disabled:cursor-not-allowed"
            />
            {isEdit && <p className="text-xs text-slate-600 mt-1">Field name cannot be changed after creation.</p>}
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">Description</label>
            <input
              type="text"
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="Human-readable label"
              className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-purple-500"
            />
          </div>

          {/* Classification */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">Sensitivity classification</label>
            <select
              value={form.classification}
              onChange={(e) => set("classification", e.target.value as SensitivityLevel)}
              className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500"
            >
              <option value="HIGH_SENSITIVE">HIGH_SENSITIVE — TOKENIZE only</option>
              <option value="MEDIUM">MEDIUM — TOKENIZE / MASK / HASH</option>
              <option value="LOW">LOW — all operations</option>
              <option value="UNCLASSIFIED">UNCLASSIFIED</option>
            </select>
          </div>

          {/* Allowed operations */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">Allowed operations</label>
            <div className="flex flex-wrap gap-2">
              {ALL_OPS.map((op) => {
                const active = form.allowed_operations.includes(op);
                return (
                  <button
                    key={op}
                    type="button"
                    onClick={() => toggleOp(op)}
                    className={clsx(
                      "px-2.5 py-1 rounded text-xs font-mono transition-colors border",
                      active
                        ? "bg-purple-600/30 border-purple-500 text-purple-300"
                        : "bg-slate-800 border-slate-600 text-slate-500 hover:border-slate-500"
                    )}
                  >
                    {active && <Check className="inline w-3 h-3 mr-1" />}
                    {op}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Type + template row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Transform type</label>
              <select
                value={form.type}
                onChange={(e) => set("type", e.target.value as RuleUpsertRequest["type"])}
                className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500"
              >
                <option value="masking">masking</option>
                <option value="fpe">fpe (format-preserving)</option>
                <option value="hash">hash</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Mask template</label>
              <input
                type="text"
                value={form.template}
                onChange={(e) => set("template", e.target.value)}
                placeholder="e.g. ***-**-####"
                className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white font-mono placeholder:text-slate-600 focus:outline-none focus:border-purple-500"
              />
            </div>
          </div>

          {/* Tweak source */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">Tweak source</label>
            <select
              value={form.tweak_source}
              onChange={(e) => set("tweak_source", e.target.value)}
              className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500"
            >
              <option value="internal">internal (auto-generated)</option>
              <option value="supplied">supplied (caller provides)</option>
            </select>
          </div>

          {/* Retention */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">Retention (days, blank = indefinite)</label>
            <input
              type="number"
              min={1}
              value={form.retention_days ?? ""}
              onChange={(e) => set("retention_days", e.target.value ? Number(e.target.value) : null)}
              placeholder="e.g. 365"
              className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-purple-500"
            />
          </div>
        </div>

          {/* Reason — only for approval mode */}
          {approvalMode && (
            <div>
              <label className="block text-xs font-medium text-amber-400 mb-1">Reason for request <span className="text-red-400">*</span></label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                placeholder="Why is this rule change needed?"
                className="w-full bg-slate-800 border border-amber-500/40 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-amber-500 resize-none"
              />
            </div>
          )}

        {/* Error */}
        {error && (
          <div className="mt-4 flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-sm text-red-400">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-3 mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className={clsx(
              "px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50 transition-colors",
              approvalMode ? "bg-amber-600 hover:bg-amber-500" : "bg-purple-600 hover:bg-purple-500"
            )}
          >
            {saving ? "Submitting…" : approvalMode
              ? "Submit for Approval"
              : isEdit ? "Save changes" : "Create rule"}
          </button>
        </div>
        </>
        )}
      </div>
    </div>
  );
}

// ── Delete Confirm Modal ───────────────────────────────────────────

function DeleteConfirmModal({
  rule,
  approvalMode,
  onClose,
  onDeleted,
}: {
  rule: TransformRule;
  approvalMode: boolean;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const handleDelete = async () => {
    if (approvalMode && !reason.trim()) { setError("Reason is required"); return; }
    setDeleting(true);
    setError(null);
    try {
      if (approvalMode) {
        const res = await fetch("/api/approvals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operation: "create",
            action: "RULE_DELETE",
            target: rule.name,
            reason: reason.trim(),
          }),
        });
        const data = await res.json();
        if (!res.ok) { setError(data.error ?? "Failed to submit request"); return; }
        setSubmitted(true);
        setTimeout(onClose, 2000);
      } else {
        const res = await fetch(`/api/transforms/${encodeURIComponent(rule.name)}`, { method: "DELETE" });
        const data = await res.json();
        if (!res.ok) { setError(data.detail ?? data.error ?? "Delete failed"); return; }
        onDeleted();
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-sm bg-slate-900 border border-red-500/30 rounded-2xl shadow-2xl p-6 mx-4">
        {submitted ? (
          <div className="py-4 text-center">
            <Check className="w-10 h-10 text-vault-green mx-auto mb-3" />
            <p className="text-vault-green font-medium">Delete request submitted for approval</p>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 mb-3">
              <AlertTriangle className="w-6 h-6 text-red-400 shrink-0" />
              <h2 className="text-lg font-bold text-white">
                {approvalMode ? "Request Rule Deletion" : "Delete Rule"}
              </h2>
            </div>
            <p className="text-sm text-slate-400 mb-2">
              {approvalMode ? "Submit a request to delete rule " : "Are you sure you want to delete the rule "}
              <span className="font-mono text-white">{rule.name}</span>?
            </p>
            {approvalMode ? (
              <div className="mb-4">
                <label className="block text-xs font-medium text-amber-400 mb-1">Reason <span className="text-red-400">*</span></label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  placeholder="Why should this rule be deleted?"
                  className="w-full bg-slate-800 border border-amber-500/40 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-amber-500 resize-none"
                />
              </div>
            ) : (
              <p className="text-xs text-slate-600 mb-5">
                The rule will be soft-deleted and removed from the live governance registry immediately.
              </p>
            )}
            {error && (
              <div className="mb-4 text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
                {error}
              </div>
            )}
            <div className="flex justify-end gap-3">
              <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-white hover:bg-slate-700 transition-colors">
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className={clsx(
                  "px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50 transition-colors",
                  approvalMode ? "bg-amber-600 hover:bg-amber-500" : "bg-red-600 hover:bg-red-500"
                )}
              >
                {deleting ? "Submitting…" : approvalMode ? "Submit for Approval" : "Delete rule"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Rule Card ──────────────────────────────────────────────────────

function RuleCard({
  rule,
  levelConfig,
  isLive,
  onEdit,
  onDelete,
}: {
  rule: TransformRule;
  levelConfig: typeof LEVEL_CONFIG[SensitivityLevel];
  isLive: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={clsx(
      "rounded-xl border bg-slate-800/50 p-4 flex items-start gap-4 hover:bg-slate-800/70 transition-colors group",
      levelConfig.border,
    )}>
      {/* Name + type + description */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <h3 className="font-mono font-bold text-white">{rule.name}</h3>
          <span className={clsx("px-2 py-0.5 rounded text-xs font-mono", TYPE_BADGE[rule.type] ?? TYPE_BADGE.hash)}>
            {rule.type.toUpperCase()}
          </span>
          <span className={clsx("px-2 py-0.5 rounded text-xs font-medium", levelConfig.badge)}>
            {levelConfig.label}
          </span>
        </div>
        <p className="text-xs text-slate-400 mb-2">{rule.description || <span className="italic text-slate-600">No description</span>}</p>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-slate-500">Allowed:</span>
          {rule.allowed_operations.map((op) => (
            <span key={op} className={clsx("px-1.5 py-0.5 rounded text-xs font-mono", levelConfig.opColor)}>
              {op}
            </span>
          ))}
        </div>
        {rule.retention_days != null && (
          <p className="text-xs text-slate-600 mt-1">Retention: {rule.retention_days}d</p>
        )}
      </div>

      {/* Template + tweak + actions */}
      <div className="flex flex-col items-end gap-2 shrink-0">
        {rule.template && (
          <div className="flex items-center gap-2 text-sm">
            <span className="font-mono text-slate-500 text-xs">input</span>
            <ArrowRight className="w-3.5 h-3.5 text-slate-600" />
            <span className="font-mono text-emerald-400 text-xs">{rule.template}</span>
          </div>
        )}
        <span className="text-xs text-slate-600">tweak: {rule.tweak_source}</span>

        {/* Edit / Delete — shown when engine is live (requester submits approval) */}
        {isLive && (
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity mt-1">
            <button
              onClick={onEdit}
              title="Edit rule"
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onDelete}
              title="Delete rule"
              className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────

export default function TransformsPage() {
  const { data: session } = useSession();
  const role = (session?.user as { role?: string })?.role ?? "requester";
  const approvalMode = role === "requester";

  const [data, setData] = useState<TransformRulesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Modal state
  const [showForm, setShowForm] = useState(false);
  const [editRule, setEditRule] = useState<TransformRule | null>(null);
  const [deleteRule, setDeleteRule] = useState<TransformRule | null>(null);

  const load = useCallback(async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const res = await fetch("/api/transforms");
      const json: TransformRulesResponse = await res.json();
      setData(json);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const grouped = data ? groupByClassification(data.rules) : {};
  const isLive = data?.source === "live";

  const handleSaved = () => {
    setShowForm(false);
    setEditRule(null);
    load(true);
  };

  const handleDeleted = () => {
    setDeleteRule(null);
    load(true);
  };

  return (
    <div className="max-w-5xl">
      {/* Modals */}
      {(showForm || editRule) && (
        <RuleFormModal
          initial={editRule
            ? {
                name: editRule.name,
                type: editRule.type,
                template: editRule.template,
                tweak_source: editRule.tweak_source,
                allowed_roles: editRule.allowed_roles,
                classification: editRule.classification,
                allowed_operations: editRule.allowed_operations,
                description: editRule.description,
                retention_days: editRule.retention_days ?? null,
              }
            : BLANK_FORM
          }
          isEdit={!!editRule}
          approvalMode={approvalMode}
          onClose={() => { setShowForm(false); setEditRule(null); }}
          onSaved={handleSaved}
        />
      )}
      {deleteRule && (
        <DeleteConfirmModal
          rule={deleteRule}
          approvalMode={approvalMode}
          onClose={() => setDeleteRule(null)}
          onDeleted={handleDeleted}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <Wand2 className="w-6 h-6 text-purple-400" />
          <h1 className="text-xl font-bold text-white">Transform Rules Engine</h1>
        </div>
        <div className="flex items-center gap-3">
          {/* Source badge */}
          {data && (
            <span className={clsx(
              "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium",
              isLive
                ? "bg-green-500/15 text-green-400 border border-green-500/25"
                : "bg-amber-500/15 text-amber-400 border border-amber-500/25"
            )}>
              {isLive ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
              {isLive ? "Live — Engine connected" : "Fallback — Engine unreachable"}
            </span>
          )}

          {/* Add rule button — always visible when live; requester goes to approval */}
          {isLive && (
            <button
              onClick={() => { setEditRule(null); setShowForm(true); }}
              className={clsx(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-white transition-colors",
                approvalMode ? "bg-amber-600 hover:bg-amber-500" : "bg-purple-600 hover:bg-purple-500"
              )}
            >
              <Plus className="w-4 h-4" />
              {approvalMode ? "Request rule" : "Add rule"}
            </button>
          )}

          <button
            onClick={() => load(true)}
            disabled={refreshing}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-colors disabled:opacity-40"
            title="Refresh"
          >
            <RefreshCw className={clsx("w-4 h-4", refreshing && "animate-spin")} />
          </button>
        </div>
      </div>

      <p className="text-sm text-slate-400 mb-1">
        PII field classification rules enforced by the T&T Engine governance layer.
        {isLive
          ? " Rules are stored in the database and applied live — changes take effect immediately."
          : " Showing read-only fallback — connect the engine to manage rules."}
      </p>
      {data && (
        <p className="text-xs text-slate-600 mb-6">
          Last fetched: {new Date(data.fetched_at).toLocaleTimeString()} · {data.rules.length} field types
        </p>
      )}

      {/* Summary counts */}
      {data && (
        <div className="grid grid-cols-3 gap-3 mb-6">
          {(["HIGH_SENSITIVE", "MEDIUM", "LOW"] as SensitivityLevel[]).map((level) => {
            const cfg = LEVEL_CONFIG[level];
            const count = grouped[level]?.length ?? 0;
            const Icon = cfg.icon;
            return (
              <div key={level} className={clsx("rounded-xl border bg-slate-800/40 p-4 flex items-center gap-3", cfg.border)}>
                <Icon className={clsx("w-5 h-5", level === "HIGH_SENSITIVE" ? "text-red-400" : level === "MEDIUM" ? "text-yellow-400" : "text-green-400")} />
                <div>
                  <p className="text-xs text-slate-500">{cfg.label}</p>
                  <p className="text-lg font-bold text-white">{count} <span className="text-sm font-normal text-slate-400">field types</span></p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Fallback notice */}
      {data && !isLive && (
        <div className="mb-6 flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 text-sm text-amber-400">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            Engine is unreachable — showing built-in default rules (read-only).
            Connect the T&T Engine to add, edit, or delete rules.
          </span>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-6">
          {[1, 2, 3].map((i) => (
            <div key={i} className="space-y-2">
              <div className="h-4 w-32 bg-slate-700 rounded animate-pulse" />
              <div className="space-y-2">
                {[1, 2].map((j) => (
                  <div key={j} className="rounded-xl border border-slate-700 bg-slate-800/50 h-20 animate-pulse" />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Grouped rules */}
      {!loading && data && (
        <div className="space-y-8">
          {SECTION_ORDER.filter((lvl) => grouped[lvl]?.length).map((level) => {
            const cfg = LEVEL_CONFIG[level];
            const LevelIcon = cfg.icon;
            return (
              <section key={level}>
                <div className="flex items-center gap-2 mb-3">
                  <LevelIcon className={clsx("w-4 h-4", level === "HIGH_SENSITIVE" ? "text-red-400" : level === "MEDIUM" ? "text-yellow-400" : "text-green-400")} />
                  <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">{cfg.label}</h2>
                  <span className={clsx("px-2 py-0.5 rounded text-xs font-medium", cfg.badge)}>
                    {grouped[level].length} rules
                  </span>
                  {level === "HIGH_SENSITIVE" && (
                    <span className="text-xs text-red-400/70 ml-1">— TOKENIZE only, no masking allowed</span>
                  )}
                </div>
                <div className="space-y-2">
                  {grouped[level].map((rule) => (
                    <RuleCard
                      key={rule.name}
                      rule={rule}
                      levelConfig={cfg}
                      isLive={isLive}
                      onEdit={() => { setShowForm(false); setEditRule(rule); }}
                      onDelete={() => setDeleteRule(rule)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
