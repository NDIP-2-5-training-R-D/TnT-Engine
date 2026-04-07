"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  FlaskConical, Play, RotateCcw, Copy, Check,
  ShieldAlert, Shield, ShieldCheck, AlertTriangle,
  ChevronDown, ChevronUp, Clock, Zap, Server, KeyRound, Lock, Fingerprint, Layers,
} from "lucide-react";
import clsx from "clsx";
import type { PlaygroundOperation, PlaygroundResult, SensitivityLevel } from "@/lib/types";

// ── Static config ──────────────────────────────────────────────────

interface FieldDef {
  label: string;
  classification: SensitivityLevel;
  allowed: PlaygroundOperation[];
  placeholder: string;
  example: string;
}

const FIELD_DEFS: Record<string, FieldDef> = {
  ssn:             { label: "SSN",              classification: "HIGH_SENSITIVE", allowed: ["TOKENIZE", "AES256_GCM96", "FF3_1"],                                                                     placeholder: "e.g. 123-45-6789",      example: "123-45-6789" },
  card:            { label: "Card Number",      classification: "HIGH_SENSITIVE", allowed: ["TOKENIZE", "AES256_GCM96", "FF3_1"],                                                                     placeholder: "e.g. 4111111111111111",  example: "4111111111111111" },
  tax_id:          { label: "Tax ID",           classification: "HIGH_SENSITIVE", allowed: ["TOKENIZE", "AES256_GCM96", "FF3_1"],                                                                     placeholder: "e.g. 12-3456789",        example: "12-3456789" },
  bank_account:    { label: "Bank Account",     classification: "HIGH_SENSITIVE", allowed: ["TOKENIZE", "AES256_GCM96", "FF3_1"],                                                                     placeholder: "e.g. 123456789012",      example: "123456789012" },
  passport:        { label: "Passport",         classification: "HIGH_SENSITIVE", allowed: ["TOKENIZE", "AES256_GCM96", "FF3_1"],                                                                     placeholder: "e.g. A12345678",         example: "A12345678" },
  email:           { label: "Email",            classification: "MEDIUM",         allowed: ["TOKENIZE", "MASK", "HMAC", "HMAC_SHA512", "AES256_GCM96", "FF3_1", "MASK_TEMPLATE"],                    placeholder: "e.g. user@example.com",  example: "user@example.com" },
  phone:           { label: "Phone",            classification: "MEDIUM",         allowed: ["TOKENIZE", "MASK", "HMAC", "HMAC_SHA512", "AES256_GCM96", "FF3_1", "MASK_TEMPLATE"],                    placeholder: "e.g. 555-867-5309",      example: "555-867-5309" },
  date_of_birth:   { label: "Date of Birth",    classification: "MEDIUM",         allowed: ["TOKENIZE", "MASK", "HMAC", "HMAC_SHA512", "AES256_GCM96", "FF3_1", "MASK_TEMPLATE"],                    placeholder: "e.g. 1990-07-15",        example: "1990-07-15" },
  drivers_license: { label: "Driver's License", classification: "MEDIUM",         allowed: ["TOKENIZE", "MASK", "HMAC", "HMAC_SHA512", "AES256_GCM96", "FF3_1", "MASK_TEMPLATE"],                    placeholder: "e.g. D12345678",         example: "D12345678" },
  name:            { label: "Full Name",        classification: "LOW",            allowed: ["TOKENIZE", "MASK", "HMAC", "HMAC_SHA512", "AES256_GCM96", "FF3_1", "MASK_TEMPLATE"],                    placeholder: "e.g. John Doe",          example: "John Doe" },
  address:         { label: "Address",          classification: "LOW",            allowed: ["TOKENIZE", "MASK", "HMAC", "HMAC_SHA512", "AES256_GCM96", "FF3_1", "MASK_TEMPLATE"],                    placeholder: "e.g. 123 Main St",       example: "123 Main St" },
  custom:          { label: "Custom Field",     classification: "UNCLASSIFIED",   allowed: ["TOKENIZE", "MASK", "HMAC", "HMAC_SHA512", "AES256_GCM96", "FF3_1", "MASK_TEMPLATE"],                    placeholder: "Any value",              example: "my-custom-value" },
};

// ── Operation metadata ─────────────────────────────────────────────

interface OpMeta {
  label: string;
  description: string;
  color: string;
  icon: React.ElementType;
  group: "standard" | "advanced";
  badge?: string;
}

const OP_META: Record<PlaygroundOperation | "DETOKENIZE", OpMeta> = {
  TOKENIZE:     { label: "TOKENIZE",        description: "Reversible — opaque tok_… token",          color: "text-emerald-400", icon: KeyRound,   group: "standard" },
  MASK:         { label: "MASK",            description: "One-way — preserves structure",             color: "text-blue-400",    icon: Shield,     group: "standard" },
  HMAC:         { label: "HMAC",            description: "SHA-256 one-way hash",                      color: "text-cyan-400",    icon: Fingerprint,group: "standard" },
  DETOKENIZE:   { label: "DETOKENIZE",      description: "Recover original value from a token",       color: "text-purple-400",  icon: KeyRound,   group: "standard" },
  HMAC_SHA512:  { label: "HMAC-SHA-512",    description: "512-bit one-way HMAC digest",               color: "text-cyan-300",    icon: Fingerprint,group: "advanced", badge: "SHA-512" },
  AES256_GCM96: { label: "AES256-GCM96",   description: "Authenticated encryption, 96-bit nonce",    color: "text-orange-400",  icon: Lock,       group: "advanced", badge: "AES" },
  FF3_1:        { label: "FF3-1",           description: "Format-Preserving Encryption (NIST)",       color: "text-pink-400",    icon: Layers,     group: "advanced", badge: "FPE" },
  MASK_TEMPLATE:{ label: "MASKING TEMPLATE",description: "Custom template: # reveal · * mask",        color: "text-blue-300",    icon: Shield,     group: "advanced", badge: "TPL" },
};

const LEVEL_STYLE: Record<SensitivityLevel, { badge: string; icon: typeof ShieldAlert; ring: string }> = {
  HIGH_SENSITIVE: { badge: "bg-red-500/20 text-red-300 border border-red-500/30",         icon: ShieldAlert,  ring: "ring-red-500/20" },
  MEDIUM:         { badge: "bg-yellow-500/20 text-yellow-300 border border-yellow-500/30",icon: Shield,       ring: "ring-yellow-500/20" },
  LOW:            { badge: "bg-green-500/20 text-green-300 border border-green-500/30",   icon: ShieldCheck,  ring: "ring-green-500/20" },
  UNCLASSIFIED:   { badge: "bg-slate-500/20 text-slate-400 border border-slate-500/30",   icon: Shield,       ring: "ring-slate-500/20" },
};

const AUTO_CLEAR_SECONDS = 120;

// ── Standard + Advanced op lists ───────────────────────────────────

const STANDARD_OPS: PlaygroundOperation[] = ["TOKENIZE", "MASK", "HMAC", "DETOKENIZE"];
const ADVANCED_OPS: PlaygroundOperation[] = ["HMAC_SHA512", "AES256_GCM96", "FF3_1", "MASK_TEMPLATE"];

// Default mask templates per field
const DEFAULT_MASK_TEMPLATES: Record<string, string> = {
  ssn:             "***-**-####",
  card:            "****-****-****-####",
  credit_card:     "****-****-****-####",
  bank_account:    "****####",
  tax_id:          "**-*******",
  passport:        "**#######",
  email:           "###@****",
  phone:           "***-***-####",
  date_of_birth:   "####-**-**",
  drivers_license: "**######",
  name:            "# D***",
  address:         "### ****",
  custom:          "##****##",
};

// ── Helper components ──────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    });
  };
  return (
    <button onClick={copy} className="p-1 rounded text-slate-500 hover:text-slate-300 transition-colors">
      {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function JsonViewer({ label, data }: { label: string; data: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-slate-700 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
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

// ── OpButton ───────────────────────────────────────────────────────

function OpButton({
  op,
  active,
  denied,
  onClick,
}: {
  op: PlaygroundOperation | "DETOKENIZE";
  active: boolean;
  denied: boolean;
  onClick: () => void;
}) {
  const meta = OP_META[op];
  const Icon = meta.icon;
  return (
    <button
      onClick={() => !denied && onClick()}
      disabled={denied}
      title={denied ? `Not allowed for this classification` : meta.description}
      className={clsx(
        "rounded-lg border px-2.5 py-2 text-left text-xs transition-colors",
        active
          ? "border-indigo-500 bg-indigo-500/20 text-white"
          : denied
            ? "border-slate-700 bg-slate-800/30 text-slate-600 cursor-not-allowed opacity-40"
            : "border-slate-600 bg-slate-800/50 text-slate-300 hover:border-slate-500 hover:text-white",
      )}
    >
      <div className="flex items-center gap-1.5 mb-0.5">
        <Icon className={clsx("w-3 h-3 shrink-0", active ? meta.color : "text-slate-500")} />
        <span className={clsx("font-mono font-semibold text-[11px]", active ? meta.color : "")}>
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
  const [fieldType, setFieldType] = useState<string>("email");
  const [operation, setOperation] = useState<PlaygroundOperation>("TOKENIZE");
  const [value, setValue] = useState("");
  const [maskTemplate, setMaskTemplate] = useState(DEFAULT_MASK_TEMPLATES["email"] ?? "##****##");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PlaygroundResult | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [clearCountdown, setClearCountdown] = useState<number | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fieldDef = FIELD_DEFS[fieldType] ?? FIELD_DEFS.custom;
  const levelStyle = LEVEL_STYLE[fieldDef.classification];
  const LevelIcon = levelStyle.icon;

  // When field changes: reset op if no longer allowed; update default template
  useEffect(() => {
    const def = FIELD_DEFS[fieldType] ?? FIELD_DEFS.custom;
    if (operation !== "DETOKENIZE" && !def.allowed.includes(operation)) {
      setOperation(def.allowed[0]);
    }
    setMaskTemplate(DEFAULT_MASK_TEMPLATES[fieldType] ?? "##****##");
  }, [fieldType]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-clear after result
  const startAutoClear = useCallback(() => {
    if (clearTimerRef.current) clearInterval(clearTimerRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);

    setClearCountdown(AUTO_CLEAR_SECONDS);
    countdownRef.current = setInterval(() => {
      setClearCountdown((v) => {
        if (v === null || v <= 1) { clearInterval(countdownRef.current!); return null; }
        return v - 1;
      });
    }, 1_000);

    clearTimerRef.current = setTimeout(() => {
      setValue("");
      setResult(null);
      setApiError(null);
      setClearCountdown(null);
    }, AUTO_CLEAR_SECONDS * 1_000);
  }, []);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, []);

  const resetAll = () => {
    setValue("");
    setResult(null);
    setApiError(null);
    setClearCountdown(null);
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);
  };

  const handleRun = async () => {
    if (!value.trim()) return;
    if (operation === "MASK_TEMPLATE" && !maskTemplate.trim()) return;
    setRunning(true);
    setResult(null);
    setApiError(null);

    try {
      const body: Record<string, string> = {
        operation,
        field_type: fieldType,
        value: value.trim(),
      };
      if (operation === "MASK_TEMPLATE") body.mask_template = maskTemplate.trim();

      const res = await fetch("/api/playground", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json() as PlaygroundResult & { error?: string };
      if (!res.ok) {
        setApiError(data.error ?? `Error ${res.status}`);
      } else {
        setResult(data);
        startAutoClear();
      }
    } catch {
      setApiError("Network error — T&T Engine unreachable");
    } finally {
      setRunning(false);
    }
  };

  const isDetokenize = operation === "DETOKENIZE";
  const isMaskTemplate = operation === "MASK_TEMPLATE";
  const opDenied = !isDetokenize && !fieldDef.allowed.includes(operation);
  const canRun = value.trim().length > 0 && !opDenied && !running
    && (!isMaskTemplate || maskTemplate.trim().length > 0);

  // Result output color per operation
  const outputColor: Record<string, string> = {
    TOKENIZE:      "text-emerald-300",
    MASK:          "text-blue-300",
    HMAC:          "text-cyan-300",
    DETOKENIZE:    "text-purple-300",
    HMAC_SHA512:   "text-cyan-200",
    AES256_GCM96:  "text-orange-300",
    FF3_1:         "text-pink-300",
    MASK_TEMPLATE: "text-blue-200",
  };

  return (
    <div className="max-w-5xl">
      {/* Header */}
      <div className="flex items-center gap-3 mb-2">
        <FlaskConical className="w-6 h-6 text-indigo-400" />
        <h1 className="text-xl font-bold text-white">T&T Engine Simulation Playground</h1>
        <span className="px-2 py-0.5 rounded-full text-xs font-mono bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
          SANDBOX
        </span>
      </div>
      <p className="text-sm text-slate-400 mb-1">
        Test tokenization, masking, HMAC, AES-256-GCM, FF3-1 FPE and masking templates against an isolated sandbox tenant.
      </p>

      {/* PII warning banner */}
      <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs mb-6">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        <span>
          <strong>Do not use real PII values.</strong> This playground runs against a sandboxed tenant
          (<code className="font-mono">tenant_id=sandbox</code>). Inputs are not logged but are processed
          by the engine. Use synthetic test data only.
        </span>
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

        {/* ── Input panel ──────────────────────────────────────────── */}
        <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-5 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-300">Input</h2>
            <button onClick={resetAll} className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 transition-colors">
              <RotateCcw className="w-3 h-3" /> Reset
            </button>
          </div>

          {/* Field type */}
          <div>
            <label className="text-xs text-slate-500 mb-1.5 block">Field Type</label>
            <div className="flex items-center gap-2">
              <select
                value={fieldType}
                onChange={(e) => setFieldType(e.target.value)}
                className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                {Object.entries(FIELD_DEFS).map(([key, def]) => (
                  <option key={key} value={key}>{def.label}</option>
                ))}
              </select>
              <span className={clsx("flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium shrink-0", levelStyle.badge)}>
                <LevelIcon className="w-3.5 h-3.5" />
                {fieldDef.classification.replace("_", " ")}
              </span>
            </div>
          </div>

          {/* Operation — Standard */}
          <div>
            <label className="text-xs text-slate-500 mb-1.5 block uppercase tracking-wider">
              Standard Operations
            </label>
            <div className="grid grid-cols-2 gap-2">
              {STANDARD_OPS.map((op) => {
                const denied = op !== "DETOKENIZE" && !fieldDef.allowed.includes(op);
                return (
                  <OpButton
                    key={op}
                    op={op}
                    active={operation === op}
                    denied={denied}
                    onClick={() => setOperation(op)}
                  />
                );
              })}
            </div>
          </div>

          {/* Operation — Advanced */}
          <div>
            <label className="text-xs text-slate-500 mb-1.5 block uppercase tracking-wider">
              Advanced Operations
            </label>
            <div className="grid grid-cols-2 gap-2">
              {ADVANCED_OPS.map((op) => {
                const denied = !fieldDef.allowed.includes(op);
                return (
                  <OpButton
                    key={op}
                    op={op}
                    active={operation === op}
                    denied={denied}
                    onClick={() => setOperation(op)}
                  />
                );
              })}
            </div>
          </div>

          {/* MASKING TEMPLATE — template input */}
          {isMaskTemplate && (
            <div>
              <label className="text-xs text-slate-500 mb-1.5 block">
                Mask Template
                <span className="text-slate-600 ml-1">— <code className="font-mono">#</code> reveal · <code className="font-mono">*</code> mask · other = separator</span>
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={maskTemplate}
                  onChange={(e) => setMaskTemplate(e.target.value)}
                  placeholder="e.g. ####-****-****-####"
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2.5 text-sm font-mono text-white placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div className="flex gap-2 mt-1.5 flex-wrap">
                {[
                  { label: "Card", tmpl: "****-****-****-####" },
                  { label: "SSN",  tmpl: "***-**-####" },
                  { label: "Email",tmpl: "###@****" },
                  { label: "Phone",tmpl: "***-***-####" },
                ].map(({ label, tmpl }) => (
                  <button
                    key={label}
                    onClick={() => setMaskTemplate(tmpl)}
                    className="text-[10px] px-2 py-0.5 rounded bg-slate-700 text-slate-400 hover:text-slate-200 hover:bg-slate-600 transition-colors font-mono"
                  >
                    {label}: {tmpl}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Value input */}
          <div>
            <label className="text-xs text-slate-500 mb-1.5 block">
              {isDetokenize ? "Token" : "Value"}
              {!isDetokenize && (
                <span className="text-slate-600 ml-1">— {fieldDef.placeholder}</span>
              )}
            </label>
            <div className="relative">
              <input
                type="text"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && canRun && handleRun()}
                placeholder={isDetokenize ? "tok_…" : fieldDef.placeholder}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
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
            {!isDetokenize && value.length > 900 && (
              <p className="text-xs text-amber-400 mt-1">{value.length}/1024 chars</p>
            )}
          </div>

          {/* Governance warning */}
          {opDenied && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 text-xs">
              <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
              <span>
                <strong>{OP_META[operation]?.label ?? operation}</strong> is not permitted for <strong>{fieldDef.classification}</strong> fields.
              </span>
            </div>
          )}

          {/* Run button */}
          <button
            onClick={handleRun}
            disabled={!canRun}
            className={clsx(
              "flex items-center justify-center gap-2 w-full py-2.5 rounded-xl font-semibold text-sm transition-all",
              canRun
                ? "bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-500/20"
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
              <>
                <Play className="w-4 h-4" />
                Run
              </>
            )}
          </button>

          {/* Auto-clear countdown */}
          {clearCountdown !== null && (
            <div className="flex items-center gap-1.5 text-xs text-slate-600">
              <Clock className="w-3 h-3" />
              Input clears in {clearCountdown}s
              <button onClick={resetAll} className="text-slate-500 hover:text-slate-300 ml-1">cancel</button>
            </div>
          )}
        </div>

        {/* ── Result panel ─────────────────────────────────────────── */}
        <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-5 flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-slate-300">Result</h2>

          {/* Error state */}
          {apiError && (
            <div className="flex-1 flex flex-col gap-3">
              <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4">
                <div className="flex items-center gap-2 mb-1">
                  <AlertTriangle className="w-4 h-4 text-red-400" />
                  <span className="text-sm font-semibold text-red-300">Error</span>
                </div>
                <p className="text-sm text-red-200/80">{apiError}</p>
              </div>
            </div>
          )}

          {/* Empty state */}
          {!result && !apiError && (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 py-12 text-slate-600">
              <FlaskConical className="w-10 h-10 opacity-30" />
              <p className="text-sm">Configure an operation and click <strong className="text-slate-500">Run</strong></p>
            </div>
          )}

          {/* Success result */}
          {result && !apiError && (
            <div className="flex flex-col gap-4">
              {/* Operation badge */}
              <div className="flex items-center gap-2">
                {(() => {
                  const meta = OP_META[result.operation as keyof typeof OP_META];
                  if (!meta) return null;
                  const Icon = meta.icon;
                  return (
                    <span className={clsx("flex items-center gap-1.5 text-xs font-mono font-semibold px-2 py-1 rounded-lg border border-indigo-500/30 bg-indigo-500/10", meta.color)}>
                      <Icon className="w-3.5 h-3.5" />
                      {meta.label}
                    </span>
                  );
                })()}
                {(result as Record<string, unknown>).algorithm && (
                  <span className="text-xs text-slate-500 font-mono">
                    {String((result as Record<string, unknown>).algorithm)}
                  </span>
                )}
              </div>

              {/* Output value */}
              <div className="rounded-xl border border-slate-600 bg-slate-900/60 p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-slate-500">
                    {result.operation === "DETOKENIZE" ? "Recovered value" : "Output"}
                  </span>
                  <div className="flex items-center gap-1">
                    {result.cached && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-400">cached</span>
                    )}
                    <CopyButton text={String(result.output_value)} />
                  </div>
                </div>
                <p className={clsx("font-mono text-sm break-all", outputColor[result.operation] ?? "text-emerald-300")}>
                  {String(result.output_value)}
                </p>
                {result.operation === "DETOKENIZE" && (
                  <p className="text-xs text-slate-500 mt-1.5">
                    Sandbox value recovered. Do not use recovered values outside of testing.
                  </p>
                )}
                {result.operation === "AES256_GCM96" && (
                  <p className="text-xs text-slate-500 mt-1.5 font-mono">
                    Format: &lt;iv_96bit&gt;.&lt;ciphertext&gt;.&lt;authtag_128bit&gt; (base64url)
                  </p>
                )}
                {result.operation === "FF3_1" && (
                  <p className="text-xs text-slate-500 mt-1.5">
                    Format preserved · Sandbox simulation (see raw response for note)
                  </p>
                )}
                {result.operation === "MASK_TEMPLATE" && (result as Record<string, unknown>).mask_template && (
                  <p className="text-xs text-slate-500 mt-1.5 font-mono">
                    Template: {String((result as Record<string, unknown>).mask_template)}
                  </p>
                )}
              </div>

              {/* Metadata badges */}
              <div className="grid grid-cols-2 gap-2">
                {/* Classification */}
                <div className="rounded-lg border border-slate-700 bg-slate-800/40 px-3 py-2">
                  <p className="text-[10px] text-slate-500 mb-1">Classification</p>
                  <div className={clsx("flex items-center gap-1 text-xs font-medium w-fit px-2 py-0.5 rounded", LEVEL_STYLE[result.classification].badge)}>
                    {(() => { const I = LEVEL_STYLE[result.classification].icon; return <I className="w-3 h-3" />; })()}
                    {result.classification.replace("_", " ")}
                  </div>
                </div>
                {/* Latency */}
                <div className="rounded-lg border border-slate-700 bg-slate-800/40 px-3 py-2">
                  <p className="text-[10px] text-slate-500 mb-1">Latency</p>
                  <div className="flex items-center gap-1 text-xs text-white">
                    <Zap className="w-3 h-3 text-yellow-400" />
                    {result.latency_ms} ms
                  </div>
                </div>
                {/* Allowed operations */}
                <div className="rounded-lg border border-slate-700 bg-slate-800/40 px-3 py-2 col-span-2">
                  <p className="text-[10px] text-slate-500 mb-1.5">Allowed operations for this field</p>
                  <div className="flex gap-1 flex-wrap">
                    {result.allowed_operations.map((op) => (
                      <span key={op} className={clsx(
                        "text-[10px] font-mono px-2 py-0.5 rounded border",
                        op === result.operation
                          ? "border-indigo-500/50 bg-indigo-500/20 text-indigo-300"
                          : "border-slate-600 text-slate-400",
                      )}>
                        {OP_META[op as keyof typeof OP_META]?.label ?? op}
                      </span>
                    ))}
                  </div>
                </div>
                {/* Sandbox indicator */}
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

              {/* JSON viewers */}
              <div className="space-y-2">
                <JsonViewer label="Raw request (plaintext redacted)" data={result.raw_request} />
                <JsonViewer label="Raw response" data={result.raw_response} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Quick reference */}
      <div className="mt-6 rounded-xl border border-slate-700 bg-slate-800/30 p-4">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
          Governance quick reference
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          {([
            {
              level: "HIGH_SENSITIVE" as SensitivityLevel,
              ops: ["TOKENIZE", "AES256_GCM96", "FF3_1"],
              desc: "SSN, Card, Tax ID, Passport, Bank Account",
            },
            {
              level: "MEDIUM" as SensitivityLevel,
              ops: ["TOKENIZE", "MASK", "HMAC", "HMAC_SHA512", "AES256_GCM96", "FF3_1", "MASK_TEMPLATE"],
              desc: "Email, Phone, Date of Birth, Driver's License",
            },
            {
              level: "LOW" as SensitivityLevel,
              ops: ["TOKENIZE", "MASK", "HMAC", "HMAC_SHA512", "AES256_GCM96", "FF3_1", "MASK_TEMPLATE"],
              desc: "Name, Address, City, ZIP",
            },
          ] as const).map(({ level, ops, desc }) => {
            const cfg = LEVEL_STYLE[level];
            const Icon = cfg.icon;
            return (
              <div key={level} className="rounded-lg border border-slate-700 bg-slate-800/40 p-3">
                <div className={clsx("flex items-center gap-1.5 px-2 py-0.5 rounded w-fit mb-2 font-medium text-[11px]", cfg.badge)}>
                  <Icon className="w-3 h-3" />
                  {level.replace("_", " ")}
                </div>
                <p className="text-slate-500 mb-1.5">{desc}</p>
                <div className="flex gap-1 flex-wrap">
                  {ops.map((op) => (
                    <span key={op} className="font-mono px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 text-[10px]">
                      {OP_META[op as keyof typeof OP_META]?.label ?? op}
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
