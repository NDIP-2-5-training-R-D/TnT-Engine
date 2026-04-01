"use client";

import { useState, useCallback } from "react";
import { ShieldAlert, AlertTriangle, Loader2 } from "lucide-react";
import { sealVault } from "@/lib/api";

type SealStep = "idle" | "confirm1" | "confirm2" | "countdown" | "executing" | "done" | "error";

export default function SealButton() {
  const [step, setStep] = useState<SealStep>("idle");
  const [inputValue, setInputValue] = useState("");
  const [countdown, setCountdown] = useState(5);
  const [result, setResult] = useState("");

  const reset = useCallback(() => {
    setStep("idle");
    setInputValue("");
    setCountdown(5);
    setResult("");
  }, []);

  const startCountdown = useCallback(() => {
    setStep("countdown");
    let count = 5;
    setCountdown(count);
    const timer = setInterval(() => {
      count -= 1;
      setCountdown(count);
      if (count <= 0) {
        clearInterval(timer);
        executeSeal();
      }
    }, 1000);
  }, []);

  const executeSeal = useCallback(async () => {
    setStep("executing");
    try {
      const res = await sealVault("SEAL-CONFIRM");
      if (res.success) {
        setStep("done");
        setResult(res.message);
      } else {
        setStep("error");
        setResult(res.message);
      }
    } catch (err) {
      setStep("error");
      setResult(`Request failed: ${err}`);
    }
  }, []);

  // Step 1: Initial idle — show warning button
  if (step === "idle") {
    return (
      <div className="rounded-xl border-2 border-vault-red/20 bg-vault-red/5 p-6">
        <div className="flex items-center gap-3 mb-4">
          <ShieldAlert className="w-6 h-6 text-vault-red" />
          <h3 className="text-lg font-bold text-vault-red">Emergency Seal</h3>
        </div>
        <p className="text-sm text-slate-400 mb-4">
          Sealing OpenBao will <strong className="text-vault-red">immediately stop all crypto operations</strong>.
          Tokenize and detokenize requests will fail until the vault is manually unsealed.
        </p>
        <button
          onClick={() => setStep("confirm1")}
          className="px-4 py-2 bg-vault-red/20 border border-vault-red/40 rounded-lg text-vault-red font-medium hover:bg-vault-red/30 transition-colors"
        >
          Initiate Emergency Seal...
        </button>
      </div>
    );
  }

  // Step 2: Type confirmation phrase
  if (step === "confirm1" || step === "confirm2") {
    return (
      <div className="rounded-xl border-2 border-vault-red/40 bg-vault-red/10 p-6">
        <div className="flex items-center gap-3 mb-4">
          <AlertTriangle className="w-6 h-6 text-vault-red animate-pulse" />
          <h3 className="text-lg font-bold text-vault-red">Confirm Emergency Seal</h3>
        </div>
        <p className="text-sm text-slate-300 mb-4">
          Type <code className="bg-slate-800 px-2 py-0.5 rounded text-vault-red font-mono">SEAL</code> to confirm:
        </p>
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value.toUpperCase())}
          className="w-full px-4 py-2 bg-slate-900 border border-slate-600 rounded-lg text-white font-mono text-center text-lg focus:border-vault-red focus:outline-none"
          placeholder="Type SEAL here..."
          autoFocus
        />
        <div className="flex gap-3 mt-4">
          <button
            onClick={reset}
            className="px-4 py-2 bg-slate-700 rounded-lg text-slate-300 hover:bg-slate-600 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={startCountdown}
            disabled={inputValue !== "SEAL"}
            className="px-4 py-2 bg-vault-red rounded-lg text-white font-medium disabled:opacity-30 disabled:cursor-not-allowed hover:bg-red-500 transition-colors"
          >
            Confirm Seal
          </button>
        </div>
      </div>
    );
  }

  // Step 3: Countdown
  if (step === "countdown") {
    return (
      <div className="rounded-xl border-2 border-vault-red/60 bg-vault-red/15 p-6 text-center">
        <AlertTriangle className="w-12 h-12 text-vault-red mx-auto mb-3 animate-bounce" />
        <p className="text-2xl font-bold text-vault-red mb-2">Sealing in {countdown}...</p>
        <p className="text-sm text-slate-400">Click cancel to abort</p>
        <button onClick={reset} className="mt-3 px-6 py-2 bg-slate-700 rounded-lg text-white hover:bg-slate-600">
          CANCEL
        </button>
      </div>
    );
  }

  // Step 4: Executing
  if (step === "executing") {
    return (
      <div className="rounded-xl border-2 border-vault-yellow/40 bg-vault-yellow/10 p-6 text-center">
        <Loader2 className="w-10 h-10 text-vault-yellow mx-auto mb-3 animate-spin" />
        <p className="text-lg font-bold text-vault-yellow">Sending seal command...</p>
      </div>
    );
  }

  // Step 5: Done or Error
  return (
    <div className={`rounded-xl border-2 p-6 text-center ${step === "done" ? "border-vault-red/60 bg-vault-red/10" : "border-vault-yellow/40 bg-vault-yellow/10"}`}>
      <p className={`text-lg font-bold ${step === "done" ? "text-vault-red" : "text-vault-yellow"}`}>
        {step === "done" ? "VAULT SEALED" : "Seal Failed"}
      </p>
      <p className="text-sm text-slate-400 mt-2">{result}</p>
      <button onClick={reset} className="mt-4 px-4 py-2 bg-slate-700 rounded-lg text-white hover:bg-slate-600">
        Dismiss
      </button>
    </div>
  );
}
