"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Shield, Loader2, AlertCircle } from "lucide-react";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    const result = await signIn("credentials", {
      username,
      password,
      redirect: false,
    });

    if (result?.error) {
      setError("Invalid username or password");
      setLoading(false);
    } else {
      router.push("/");
      router.refresh();
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <Shield className="w-12 h-12 text-vault-green mx-auto mb-3" />
          <h1 className="text-2xl font-bold text-white">T&T Control Plane</h1>
          <p className="text-sm text-slate-500 mt-1">Secure Infrastructure Management</p>
        </div>

        {/* Login Form */}
        <form onSubmit={handleSubmit} className="rounded-xl border border-slate-700 bg-slate-900 p-6 space-y-4">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-4 py-2.5 bg-slate-800 border border-slate-600 rounded-lg text-white focus:border-vault-green focus:outline-none"
              placeholder="admin"
              autoFocus
              required
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-2.5 bg-slate-800 border border-slate-600 rounded-lg text-white focus:border-vault-green focus:outline-none"
              placeholder="••••••••"
              required
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 text-sm text-vault-red">
              <AlertCircle className="w-4 h-4" />
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !username || !password}
            className="w-full py-2.5 bg-vault-green/20 border border-vault-green/40 rounded-lg text-vault-green font-medium hover:bg-vault-green/30 transition-colors disabled:opacity-40"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : "Sign In"}
          </button>
        </form>

        {/* Dev credentials hint */}
        <div className="mt-4 rounded-lg border border-slate-800 bg-slate-900/50 p-3">
          <p className="text-[10px] text-slate-600 uppercase tracking-wider mb-2">Dev Credentials</p>
          <div className="space-y-1 text-xs font-mono text-slate-500">
            <p><span className="text-slate-400">admin</span> / admin123 — Full access</p>
            <p><span className="text-slate-400">operator</span> / oper123 — Operations</p>
            <p><span className="text-slate-400">viewer</span> / view123 — Read only</p>
          </div>
        </div>
      </div>
    </div>
  );
}
