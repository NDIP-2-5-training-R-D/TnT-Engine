"use client";

import { useState, useEffect } from "react";
import { Wand2, ArrowRight, Wifi, WifiOff, RefreshCw, ShieldAlert, Shield, ShieldCheck } from "lucide-react";
import clsx from "clsx";
import type { TransformRule, TransformRulesResponse, SensitivityLevel } from "@/lib/types";

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

function groupByClassification(rules: TransformRule[]): Record<string, TransformRule[]> {
  return rules.reduce<Record<string, TransformRule[]>>((acc, rule) => {
    const key = rule.classification ?? "UNCLASSIFIED";
    if (!acc[key]) acc[key] = [];
    acc[key].push(rule);
    return acc;
  }, {});
}

// ── Component ──────────────────────────────────────────────────────

export default function TransformsPage() {
  const [data, setData] = useState<TransformRulesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async (showRefresh = false) => {
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
  };

  useEffect(() => { load(); }, []);

  const grouped = data ? groupByClassification(data.rules) : {};

  return (
    <div className="max-w-5xl">
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
              data.source === "live"
                ? "bg-green-500/15 text-green-400 border border-green-500/25"
                : "bg-amber-500/15 text-amber-400 border border-amber-500/25"
            )}>
              {data.source === "live"
                ? <Wifi className="w-3 h-3" />
                : <WifiOff className="w-3 h-3" />}
              {data.source === "live" ? "Live — Engine connected" : "Fallback — Engine unreachable"}
            </span>
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
        Canonical PII field classifications enforced by the T&T Engine governance layer.
        Rules mirror <code className="text-slate-300 bg-slate-700/50 px-1 rounded">classification.py</code> +{" "}
        <code className="text-slate-300 bg-slate-700/50 px-1 rounded">masking.py</code>.
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
                    <RuleCard key={rule.name} rule={rule} levelConfig={cfg} />
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

function RuleCard({
  rule,
  levelConfig,
}: {
  rule: TransformRule;
  levelConfig: typeof LEVEL_CONFIG[SensitivityLevel];
}) {
  return (
    <div className={clsx(
      "rounded-xl border bg-slate-800/50 p-4 flex items-start gap-4 hover:bg-slate-800/70 transition-colors",
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
        <p className="text-xs text-slate-400 mb-2">{rule.description}</p>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-slate-500">Allowed:</span>
          {rule.allowed_operations.map((op) => (
            <span key={op} className={clsx("px-1.5 py-0.5 rounded text-xs font-mono", levelConfig.opColor)}>
              {op}
            </span>
          ))}
        </div>
      </div>

      {/* Template + tweak */}
      <div className="flex flex-col items-end gap-2 shrink-0">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-mono text-slate-500 text-xs">input</span>
          <ArrowRight className="w-3.5 h-3.5 text-slate-600" />
          <span className="font-mono text-emerald-400 text-xs">{rule.template}</span>
        </div>
        <span className="text-xs text-slate-600">tweak: {rule.tweak_source}</span>
      </div>
    </div>
  );
}
