"use client";

import { useState, useEffect } from "react";
import { Wand2, ArrowRight } from "lucide-react";
import clsx from "clsx";
import type { TransformRule } from "@/lib/types";

export default function TransformsPage() {
  const [rules, setRules] = useState<TransformRule[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/transforms").then((r) => r.json()).then(setRules).finally(() => setLoading(false));
  }, []);

  return (
    <div className="max-w-5xl">
      <div className="flex items-center gap-3 mb-6">
        <Wand2 className="w-6 h-6 text-purple-400" />
        <h1 className="text-xl font-bold text-white">Transform Rules Engine</h1>
      </div>
      <p className="text-sm text-slate-400 mb-6">
        Format-Preserving Encryption (FPE) and Masking rules applied by the T&T Engine during tokenization.
      </p>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <div key={i} className="rounded-xl border border-slate-700 bg-slate-800/50 h-24 animate-pulse" />)}
        </div>
      ) : (
        <div className="space-y-3">
          {rules.map((rule) => (
            <div key={rule.name} className="rounded-xl border border-slate-700 bg-slate-800/50 p-5 flex items-center gap-6">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-mono font-bold text-white">{rule.name}</h3>
                  <span className={clsx("px-2 py-0.5 rounded text-xs font-mono",
                    rule.type === "fpe" ? "bg-purple-500/20 text-purple-300" : "bg-blue-500/20 text-blue-300"
                  )}>{rule.type.toUpperCase()}</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-slate-400">
                  <span>Tweak: {rule.tweak_source}</span>
                  <span className="text-slate-600">|</span>
                  <span>Roles: {rule.allowed_roles.join(", ")}</span>
                </div>
              </div>
              <div className="flex items-center gap-3 text-sm">
                <span className="font-mono text-slate-500">input</span>
                <ArrowRight className="w-4 h-4 text-slate-600" />
                <span className="font-mono text-vault-green">{rule.template}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
