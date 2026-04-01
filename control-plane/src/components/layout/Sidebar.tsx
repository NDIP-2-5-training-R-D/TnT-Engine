"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard, Key, FileCode, UserPlus, Wand2,
  FileText, AlertTriangle, Shield, ShieldCheck,
  Database, Download,
} from "lucide-react";
import clsx from "clsx";
import NamespaceSwitcher from "./NamespaceSwitcher";

const navSections = [
  {
    label: "Monitor",
    links: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
      { href: "/audit", label: "Audit Log", icon: FileText },
    ],
  },
  {
    label: "Governance",
    links: [
      { href: "/keys", label: "Key Management", icon: Key },
      { href: "/policies", label: "Policies", icon: FileCode },
      { href: "/approles", label: "AppRoles", icon: UserPlus },
      { href: "/transforms", label: "Transform Rules", icon: Wand2 },
      { href: "/approvals", label: "Approvals", icon: ShieldCheck },
    ],
  },
  {
    label: "Operations",
    links: [
      { href: "/backups", label: "Backups", icon: Database },
      { href: "/emergency", label: "Emergency", icon: AlertTriangle },
    ],
  },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-56 bg-slate-900 border-r border-slate-700 flex flex-col min-h-screen">
      {/* Logo */}
      <div className="p-4 border-b border-slate-700">
        <div className="flex items-center gap-2">
          <Shield className="w-6 h-6 text-vault-green" />
          <span className="font-bold text-lg">T&T Control</span>
        </div>
        <p className="text-xs text-slate-500 mt-1">Governance Center</p>
      </div>

      {/* Namespace Switcher */}
      <NamespaceSwitcher />

      {/* Navigation — grouped by section */}
      <nav className="flex-1 p-3 space-y-4 overflow-y-auto">
        {navSections.map((section) => (
          <div key={section.label}>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-600 px-3 mb-1">
              {section.label}
            </p>
            <div className="space-y-0.5">
              {section.links.map(({ href, label, icon: Icon }) => (
                <Link
                  key={href}
                  href={href}
                  className={clsx(
                    "flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
                    pathname === href
                      ? "bg-slate-700/60 text-white"
                      : "text-slate-400 hover:text-white hover:bg-slate-800"
                  )}
                >
                  <Icon className="w-4 h-4" />
                  {label}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="p-4 border-t border-slate-700 text-xs text-slate-600">
        T&T Engine v0.6.0
      </div>
    </aside>
  );
}
