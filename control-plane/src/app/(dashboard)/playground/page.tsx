"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  FlaskConical, Play, RotateCcw, Copy, Check,
  ShieldAlert, Shield, ShieldCheck, AlertTriangle,
  ChevronDown, ChevronUp, Clock, Zap, Server,
  KeyRound, Lock, Fingerprint, Layers,
} from "lucide-react";
import clsx from "clsx";
import {
  PlaygroundOp,
  OPERATION_EXTRA_FIELD,
} from "@/lib/types";
import type {
  PlaygroundOperation,
  PlaygroundResult,
  SensitivityLevel,
} from "@/lib/types";
import type { OpMeta, FieldDefMeta } from "@/app/api/playground/meta/route";

// ── Classification display config ──────────────────────────────────

const LEVEL_STYLE: Record<SensitivityLevel, { badge: string; icon: typeof ShieldAlert }> = {
  HIGH_SENSITIVE: { badge: "bg-red-500/20 text-red-300 border border-red-500/30",          icon: ShieldAlert },
  MEDIUM:         { badge: "bg-yellow-500/20 text-yellow-300 border border-yellow-500/30", icon: Shield      },
  LOW:            { badge: "bg-green-500/20 text-green-300 border border-green-500/30",    icon: ShieldCheck },
  UNCLASSIFIED:   { badge: "bg-slate-500/20 text-slate-400 border border-slate-500/30",    icon: Shield      },
};

const OP_ICON: Record<string, React.ElementType> = {
  [PlaygroundOp.TOKENIZE]:      KeyRound,
  [PlaygroundOp.MASK]:          Shield,
  [PlaygroundOp.HMAC]:          Fingerprint,
  [PlaygroundOp.DETOKENIZE]:    KeyRound,
  [PlaygroundOp.HMAC_SHA512]:   Fingerprint,
  [PlaygroundOp.AES256_GCM96]:  Lock,
  [PlaygroundOp.FF3_1]:         Layers,
  [PlaygroundOp.MASK_TEMPLATE]: Shield,
};

const OP_COLOR: Record<string, string> = {
  [PlaygroundOp.TOKENIZE]:      "text-emerald-400",
  [PlaygroundOp.MASK]:          "text-blue-400",
  [PlaygroundOp.HMAC]:          "text-cyan-400",
  [PlaygroundOp.DETOKENIZE]:    "text-purple-400",
  [PlaygroundOp.HMAC_SHA512]:   "text-cyan-300",
  [PlaygroundOp.AES256_GCM96]:  "text-orange-400",
  [PlaygroundOp.FF3_1]:         "text-pink-400",
  [PlaygroundOp.MASK_TEMPLATE]: "text-blue-300",
};

const AUTO_CLEAR_SECONDS = 120;

// ── Static fallback field defs (used while meta is loading) ───────

const FALLBACK_FIELD_DEFS: FieldDefMeta[] = [
  { name: "email",  label: "Email",       classification: "MEDIUM",       allowed_operations: [PlaygroundOp.TOKENIZE, PlaygroundOp.MASK, PlaygroundOp.HMAC, PlaygroundOp.HMAC_SHA512, PlaygroundOp.AES256_GCM96, PlaygroundOp.FF3_1, PlaygroundOp.MASK_TEMPLATE], template: "j***@domain",  placeholder: "e.g. user@example.com", example: "user@example.com" },
  { name: "custom", label: "Custom Field", classification: "UNCLASSIFIED", allowed_operations: [PlaygroundOp.TOKENIZE, PlaygroundOp.MASK, PlaygroundOp.HMAC, PlaygroundOp.HMAC_SHA512, PlaygroundOp.AES256_GCM96, PlaygroundOp.FF3_1, PlaygroundOp.MASK_TEMPLATE], template: "##****##",    placeholder: "Any value",             example: "my-custom-value" },
];

// ── Helper components ──────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => navigator.clipboard.writeText(text).then(() => {
        setCopied(true); setTimeout(() => setCopied(false), 2_000);
      })}
      className="p-1 rounded text-slate-500 hover:text-slate-300 transition-colors"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function JsonViewer({ label, data }: { label: string; data: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-slate-700 overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-700/30 transition-colors"
      >
        <span>{label}</span>
        {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>
      {open && (
        <pre className="px-3 py-2 bg-slate-900/50 text-xs text-slate-300 overflow-x-auto border-t border-slate-700">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}

function OpButton({
  op, meta, active, denied, onClick,
}: {
  op: PlaygroundOperation;
  meta: OpMeta;
  active: boolean;
  denied: boolean;
  onClick: () => void;
}) {
  const Icon = OP_ICON[op] ?? Shield;
  const color = OP_COLOR[op] ?? "text-slate-400";
  return (
    <button
      onClick={() => !denied && onClick()}
      disabled={denied}
      title={denied ? "Not allowed for this classification" : meta.description}
      className={clsx(
        "rounded-lg border px-2.5 py-2 text-left text-xs transition-colors",
        active   ? "border-indigo-500 bg-indigo-500/20 text-white"
        : denied ? "border-slate-700 bg-slate-800/30 text-slate-600 cursor-not-allowed opacity-40"
                 : "border-slate-600 bg-slate-800/50 text-slate-300 hover:border-slate-500 hover:text-white",
      )}
    >
      <div className="flex items-center gap-1.5 mb-0.5">
        <Icon className={clsx("w-3 h-3 shrink-0", active ? color : "text-slate-500")} />
        <span className={clsx("font-mono font-semibold text-[11px]", active ? color : "")}>
          {meta.label}
        </span>
        {meta.badge && (
          <span className={clsx(
            "ml-auto text-[9px] font-bold px-1 py-0.5 rounded",
            active ? "bg-indigo-500/30 text-indigo-300" : "bg-slate-700 text-slate-500",
          )}>
            {meta.badge}
          </span>
        )}
      </div>
      <span className="text-slate-500 text-[10px] leading-tight block pl-4">{meta.description}</span>
    </button>
  );
}

// ── Main component ─────────────────────────────────────────────────

export default function PlaygroundPage() {
  const [fieldType, setFieldType]       = useState("email");
  const [operation, setOperation]       = useState<PlaygroundOperation>(PlaygroundOp.TOKENIZE);
  const [value, setValue]               = useState("");
  const [maskTemplate, setMaskTemplate] = useState("###@****");
  const [running, setRunning]           = useState(false);
  const [result, setResult]             = useState<PlaygroundResult | null>(null);
  const [apiError, setApiError]         = useState<string | null>(null);
  const [clearCountdown, setClearCountdown] = useState<number | null>(null);

  // Dynamic data from /api/playground/meta
  const [opCatalogue, setOpCatalogue]   = useState<OpMeta[]>([]);
  const [maskTemplates, setMaskTemplates] = useState<Record<string, string>>({});
  const [fieldDefs, setFieldDefs]       = useState<FieldDefMeta[]>(FALLBACK_FIELD_DEFS);
  const [metaSource, setMetaSource]     = useState<"live" | "fallback" | null>(null);

  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef  = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch all playground metadata from BFF (which reads from transform_rules)
  useEffect(() => {
    fetch("/api/playground/meta")
      .then(r => r.json())
      .then((data: {
        operations: OpMeta[];
        mask_templates: Record<string, string>;
        field_defs: FieldDefMeta[];
        source: "live" | "fallback";
      }) => {
        if (data.operations?.length)  setOpCatalogue(data.operations);
        if (data.mask_templates)      setMaskTemplates(data.mask_templates);
        if (data.field_defs?.length)  setFieldDefs(data.field_defs);
        setMetaSource(data.source ?? "fallback");
      })
      .catch(() => { /* keep fallback */ });
  }, []);

  // Lookup helpers from dynamic field defs
  const fieldDefMap = Object.fromEntries(fieldDefs.map(d => [d.name, d]));
  const fieldDef    = fieldDefMap[fieldType] ?? fieldDefs[fieldDefs.length - 1] ?? FALLBACK_FIELD_DEFS[0];
  const levelStyle  = LEVEL_STYLE[fieldDef.classification];
  const LevelIcon   = levelStyle.icon;
  const standardOps = opCatalogue.filter(m => m.group === "standard");
  const advancedOps = opCatalogue.filter(m => m.group === "advanced");
  const opMetaMap   = Object.fromEntries(opCatalogue.map(m => [m.id, m]));

  // When field changes: reset op if no longer allowed, update default template
  useEffect(() => {
    const def = fieldDefMap[fieldType];
    if (!def) return;
    if (operation !== PlaygroundOp.DETOKENIZE && !def.allowed_operations.includes(operation)) {
      setOperation(def.allowed_operations[0] ?? PlaygroundOp.TOKENIZE);
    }
    if (maskTemplates[fieldType]) setMaskTemplate(maskTemplates[fieldType]);
  }, [fieldType, maskTemplates]); // eslint-disable-line react-hooks/exhaustive-deps

  const startAutoClear = useCallback(() => {
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    if (countdownRef.current)  clearInterval(countdownRef.current);
    setClearCountdown(AUTO_CLEAR_SECONDS);
    countdownRef.current = setInterval(() => {
      setClearCountdown(v => {
        if (v === null || v <= 1) { clearInterval(countdownRef.current!); return null; }
        return v - 1;
      });
    }, 1_000);
    clearTimerRef.current = setTimeout(() => {
      setValue(""); setResult(null); setApiError(null); setClearCountdown(null);
    }, AUTO_CLEAR_SECONDS * 1_000);
  }, []);

  useEffect(() => () => {
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    if (countdownRef.current)  clearInterval(countdownRef.current);
  }, []);

  const resetAll = () => {
    setValue(""); setResult(null); setApiError(null); setClearCountdown(null);
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    if (countdownRef.current)  clearInterval(countdownRef.current);
  };

  const handleRun = async () => {
    if (!value.trim()) return;
    if (operation === PlaygroundOp.MASK_TEMPLATE && !maskTemplate.trim()) return;
    setRunning(true); setResult(null); setApiError(null);

    try {
      const body: Record<string, string> = {
        operation,
        field_type: fieldType,
        value: value.trim(),
      };
      const extraField = OPERATION_EXTRA_FIELD[operation];
      if (extraField) body[extraField] = maskTemplate.trim();

      const res  = await fetch("/api/playground", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json() as PlaygroundResult & { error?: string };
      if (!res.ok) setApiError(data.error ?? `Error ${res.status}`);
      else { setResult(data); startAutoClear(); }
    } catch {
      setApiError("Network error — T&T Engine unreachable");
    } finally {
      setRunning(false);
    }
  };

  const isDetokenize = operation === PlaygroundOp.DETOKENIZE;
  const isMaskTmpl   = operation === PlaygroundOp.MASK_TEMPLATE;
  const opDenied     = !isDetokenize && !fieldDef.allowed_operations.includes(operation);
  const canRun       = value.trim().length > 0 && !opDenied && !running
                       && (!isMaskTmpl || maskTemplate.trim().length > 0);

  // Template quick-fill presets derived from fetched templates
  const templatePresets = Object.entries(maskTemplates)
    .filter(([, tmpl]) => tmpl)
    .slice(0, 6)
    .map(([name, tmpl]) => ({ label: fieldDefMap[name]?.label ?? name, tmpl }));

  return (
    <div className="max-w-5xl">
      {/* Header */}
      <div className="flex items-center gap-3 mb-2">
        <FlaskConical className="w-6 h-6 text-indigo-400" />
        <h1 className="text-xl font-bold text-white">T&T Engine Simulation Playground</h1>
        <span className="px-2 py-0.5 rounded-full text-xs font-mono bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">SANDBOX</span>
        {metaSource === "live" && (
          <span className="px-2 py-0.5 rounded-full text-xs bg-green-500/15 text-green-400 border border-green-500/25">
            {fieldDefs.length} field types — live
          </span>
        )}
      </div>
      <p className="text-sm text-slate-400 mb-1">
        Test tokenization, masking, HMAC, AES-256-GCM96 and FF3-1 FPE against an isolated sandbox tenant.
        Field types and allowed operations reflect the current transform rules.
      </p>

      {/* PII warning */}
      <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs mb-6">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        <span>
          <strong>Do not use real PII values.</strong> This playground runs against a sandboxed tenant
          (<code className="font-mono">tenant_id=sandbox</code>). Use synthetic test data only.
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Input panel */}
        <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-5 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-300">Input</h2>
            <button onClick={resetAll} className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 transition-colors">
              <RotateCcw className="w-3 h-3" /> Reset
            </button>
          </div>

          {/* Field type — built from dynamic transform rules */}
          <div>
            <label className="text-xs text-slate-500 mb-1.5 block">Field Type</label>
            <div className="flex items-center gap-2">
              <select
                value={fieldType}
                onChange={e => setFieldType(e.target.value)}
                className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                {fieldDefs.map(def => (
                  <option key={def.name} value={def.name}>{def.label}</option>
                ))}
              </select>
              <span className={clsx("flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium shrink-0", levelStyle.badge)}>
                <LevelIcon className="w-3.5 h-3.5" />
                {fieldDef.classification.replace("_", " ")}
              </span>
            </div>
          </div>

          {/* Standard ops */}
          {standardOps.length > 0 && (
            <div>
              <label className="text-xs text-slate-500 mb-1.5 block uppercase tracking-wider">Standard Operations</label>
              <div className="grid grid-cols-2 gap-2">
                {standardOps.map(meta => (
                  <OpButton
                    key={meta.id}
                    op={meta.id}
                    meta={meta}
                    active={operation === meta.id}
                    denied={meta.id !== PlaygroundOp.DETOKENIZE && !fieldDef.allowed_operations.includes(meta.id)}
                    onClick={() => setOperation(meta.id)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Advanced ops */}
          {advancedOps.length > 0 && (
            <div>
              <label className="text-xs text-slate-500 mb-1.5 block uppercase tracking-wider">Advanced Operations</label>
              <div className="grid grid-cols-2 gap-2">
                {advancedOps.map(meta => (
                  <OpButton
                    key={meta.id}
                    op={meta.id}
                    meta={meta}
                    active={operation === meta.id}
                    denied={!fieldDef.allowed_operations.includes(meta.id)}
                    onClick={() => setOperation(meta.id)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* MASKING TEMPLATE — template input */}
          {isMaskTmpl && (
            <div>
              <label className="text-xs text-slate-500 mb-1.5 block">
                Mask Template
                <span className="text-slate-600 ml-1">—
                  <code className="font-mono ml-1">#</code> reveal ·
                  <code className="font-mono ml-1">*</code> mask · other = separator
                </span>
              </label>
              <input
                type="text"
                value={maskTemplate}
                onChange={e => setMaskTemplate(e.target.value)}
                placeholder="e.g. ####-****-****-####"
                autoComplete="off"
                spellCheck={false}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2.5 text-sm font-mono text-white placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              {templatePresets.length > 0 && (
                <div className="flex gap-2 mt-1.5 flex-wrap">
                  {templatePresets.map(({ label, tmpl }) => (
                    <button
                      key={label}
                      onClick={() => setMaskTemplate(tmpl)}
                      className="text-[10px] px-2 py-0.5 rounded bg-slate-700 text-slate-400 hover:text-slate-200 hover:bg-slate-600 transition-colors font-mono"
                    >
                      {label}: {tmpl}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Value input */}
          <div>
            <label className="text-xs text-slate-500 mb-1.5 block">
              {isDetokenize ? "Token" : "Value"}
              {!isDetokenize && <span className="text-slate-600 ml-1">— {fieldDef.placeholder}</span>}
            </label>
            <div className="relative">
              <input
                type="text"
                value={value}
                onChange={e => setValue(e.target.value)}
                onKeyDown={e => e.key === "Enter" && canRun && handleRun()}
                placeholder={isDetokenize ? "tok_…" : fieldDef.placeholder}
                autoComplete="off" autoCorrect="off" spellCheck={false}
                maxLength={1024}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2.5 text-sm font-mono text-white placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              {!isDetokenize && !value && (
                <button
                  onClick={() => setValue(fieldDef.example)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-600 hover:text-slate-400 transition-colors px-1"
                >
                  use example
                </button>
              )}
            </div>
            {value.length > 900 && (
              <p className="text-xs text-amber-400 mt-1">{value.length}/1024 chars</p>
            )}
          </div>

          {/* Governance warning */}
          {opDenied && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 text-xs">
              <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
              <span>
                <strong>{opMetaMap[operation]?.label ?? operation}</strong> is not permitted for <strong>{fieldDef.classification}</strong> fields.
              </span>
            </div>
          )}

          {/* Run button */}
          <button
            onClick={handleRun}
            disabled={!canRun}
            className={clsx(
              "flex items-center justify-center gap-2 w-full py-2.5 rounded-xl font-semibold text-sm transition-all",
              canRun ? "bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-500/20"
                     : "bg-slate-700 text-slate-500 cursor-not-allowed",
            )}
          >
            {running ? (
              <>
                <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
                Running…
              </>
            ) : (
              <><Play className="w-4 h-4" />Run</>
            )}
          </button>

          {clearCountdown !== null && (
            <div className="flex items-center gap-1.5 text-xs text-slate-600">
              <Clock className="w-3 h-3" />
              Input clears in {clearCountdown}s
              <button onClick={resetAll} className="text-slate-500 hover:text-slate-300 ml-1">cancel</button>
            </div>
          )}
        </div>

        {/* Result panel */}
        <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-5 flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-slate-300">Result</h2>

          {apiError && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4">
              <div className="flex items-center gap-2 mb-1">
                <AlertTriangle className="w-4 h-4 text-red-400" />
                <span className="text-sm font-semibold text-red-300">Error</span>
              </div>
              <p className="text-sm text-red-200/80">{apiError}</p>
            </div>
          )}

          {!result && !apiError && (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 py-12 text-slate-600">
              <FlaskConical className="w-10 h-10 opacity-30" />
              <p className="text-sm">Configure an operation and click <strong className="text-slate-500">Run</strong></p>
            </div>
          )}

          {result && !apiError && (
            <div className="flex flex-col gap-4">
              {/* Op badge */}
              {(() => {
                const meta = opMetaMap[result.operation];
                if (!meta) return null;
                const Icon = OP_ICON[result.operation] ?? Shield;
                const color = OP_COLOR[result.operation] ?? "text-slate-400";
                return (
                  <span className={clsx("flex items-center gap-1.5 text-xs font-mono font-semibold px-2 py-1 rounded-lg border border-indigo-500/30 bg-indigo-500/10 w-fit", color)}>
                    <Icon className="w-3.5 h-3.5" /> {meta.label}
                  </span>
                );
              })()}

              {/* Output */}
              <div className="rounded-xl border border-slate-600 bg-slate-900/60 p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-slate-500">
                    {result.operation === PlaygroundOp.DETOKENIZE ? "Recovered value" : "Output"}
                  </span>
                  <div className="flex items-center gap-1">
                    {result.cached && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-400">cached</span>}
                    <CopyButton text={String(result.output_value)} />
                  </div>
                </div>
                <p className={clsx("font-mono text-sm break-all", OP_COLOR[result.operation] ?? "text-emerald-300")}>
                  {String(result.output_value)}
                </p>
                {result.operation === PlaygroundOp.FF3_1 && (
                  <p className="text-xs text-slate-500 mt-1.5">Format preserved · DEK from OpenBao envelope decryption</p>
                )}
                {result.operation === PlaygroundOp.AES256_GCM96 && (
                  <p className="text-xs text-slate-500 mt-1.5 font-mono">vault:vN:&lt;base64&gt; format</p>
                )}
              </div>

              {/* Metadata badges */}
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg border border-slate-700 bg-slate-800/40 px-3 py-2">
                  <p className="text-[10px] text-slate-500 mb-1">Classification</p>
                  <div className={clsx("flex items-center gap-1 text-xs font-medium w-fit px-2 py-0.5 rounded", LEVEL_STYLE[result.classification].badge)}>
                    {(() => { const I = LEVEL_STYLE[result.classification].icon; return <I className="w-3 h-3" />; })()}
                    {result.classification.replace("_", " ")}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-700 bg-slate-800/40 px-3 py-2">
                  <p className="text-[10px] text-slate-500 mb-1">Latency</p>
                  <div className="flex items-center gap-1 text-xs text-white">
                    <Zap className="w-3 h-3 text-yellow-400" />{result.latency_ms} ms
                  </div>
                </div>
                <div className="rounded-lg border border-slate-700 bg-slate-800/40 px-3 py-2 col-span-2">
                  <p className="text-[10px] text-slate-500 mb-1.5">Allowed operations for this field</p>
                  <div className="flex gap-1 flex-wrap">
                    {result.allowed_operations.map(op => (
                      <span key={op} className={clsx(
                        "text-[10px] font-mono px-2 py-0.5 rounded border",
                        op === result.operation
                          ? "border-indigo-500/50 bg-indigo-500/20 text-indigo-300"
                          : "border-slate-600 text-slate-400",
                      )}>
                        {opMetaMap[op as PlaygroundOperation]?.label ?? op}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="rounded-lg border border-slate-700 bg-slate-800/40 px-3 py-2 col-span-2">
                  <div className="flex items-center gap-1.5 text-xs text-slate-500">
                    <Server className="w-3 h-3" />
                    Engine processed · Audit log written · Sandbox tenant
                  </div>
                  {(result as Record<string, unknown>).algorithm && (
                    <p className="text-[10px] text-slate-600 mt-1 font-mono truncate">
                      {String((result as Record<string, unknown>).algorithm)}
                    </p>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <JsonViewer label="Raw request (plaintext redacted)" data={result.raw_request} />
                <JsonViewer label="Raw response" data={result.raw_response} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Governance quick reference — built from dynamic field defs */}
      <div className="mt-6 rounded-xl border border-slate-700 bg-slate-800/30 p-4">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
          Governance quick reference
          {metaSource === "live" && <span className="ml-2 text-green-400/70 normal-case font-normal">(live from transform rules)</span>}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          {(["HIGH_SENSITIVE", "MEDIUM", "LOW"] as SensitivityLevel[]).map((level) => {
            const cfg = LEVEL_STYLE[level];
            const Icon = cfg.icon;
            const fieldsAtLevel = fieldDefs.filter(d => d.classification === level);
            const ops = fieldsAtLevel[0]?.allowed_operations ?? [];
            const desc = fieldsAtLevel.map(d => d.label).join(", ") || "—";
            return (
              <div key={level} className="rounded-lg border border-slate-700 bg-slate-800/40 p-3">
                <div className={clsx("flex items-center gap-1.5 px-2 py-0.5 rounded w-fit mb-2 font-medium text-[11px]", cfg.badge)}>
                  <Icon className="w-3 h-3" />{level.replace("_", " ")}
                </div>
                <p className="text-slate-500 mb-1.5 text-[11px]">{desc}</p>
                <div className="flex gap-1 flex-wrap">
                  {ops.map(op => (
                    <span key={op} className="font-mono px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 text-[10px]">
                      {opMetaMap[op as PlaygroundOperation]?.label ?? op}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
