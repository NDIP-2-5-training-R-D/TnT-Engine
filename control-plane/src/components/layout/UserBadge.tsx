"use client";

import { useSession, signOut } from "next-auth/react";
import { User, LogOut } from "lucide-react";
import clsx from "clsx";

const roleColors: Record<string, string> = {
  admin: "bg-vault-red/20 text-vault-red border-vault-red/30",
  operator: "bg-vault-yellow/20 text-vault-yellow border-vault-yellow/30",
  viewer: "bg-vault-blue/20 text-vault-blue border-vault-blue/30",
};

export default function UserBadge() {
  const { data: session } = useSession();

  if (!session?.user) return null;

  const role = (session.user as any).role || "viewer";
  const name = session.user.name || "Unknown";

  return (
    <div className="flex items-center gap-3">
      <div className="w-2 h-2 rounded-full bg-vault-green animate-pulse" />
      <span className="text-xs text-slate-500">Live</span>
      <div className="flex items-center gap-2">
        <User className="w-3.5 h-3.5 text-slate-500" />
        <span className="text-xs text-slate-300">{name}</span>
        <span className={clsx("text-[10px] px-1.5 py-0.5 rounded border font-mono uppercase", roleColors[role] || roleColors.viewer)}>
          {role}
        </span>
      </div>
      <button
        onClick={() => signOut({ callbackUrl: "/login" })}
        className="text-slate-600 hover:text-slate-300 transition-colors"
        title="Sign out"
      >
        <LogOut className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
