"use client";

import { useNamespace } from "@/lib/namespace-context";
import { Layers } from "lucide-react";

export default function NamespaceSwitcher() {
  const { namespace, setNamespace, namespaces } = useNamespace();

  return (
    <div className="px-4 py-2 border-b border-slate-700">
      <div className="flex items-center gap-2 mb-1">
        <Layers className="w-3.5 h-3.5 text-slate-500" />
        <span className="text-[10px] text-slate-500 uppercase tracking-wider">Namespace</span>
      </div>
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
    </div>
  );
}
