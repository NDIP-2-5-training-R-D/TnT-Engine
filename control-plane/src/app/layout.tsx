import type { Metadata } from "next";
import "./globals.css";
import Sidebar from "@/components/layout/Sidebar";
import SessionProvider from "@/components/layout/SessionProvider";
import UserBadge from "@/components/layout/UserBadge";
import { NamespaceProvider } from "@/lib/namespace-context";

export const metadata: Metadata = {
  title: "T&T Control Plane",
  description: "Secure dashboard for OpenBao/HSM infrastructure management",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">
        <SessionProvider>
          <NamespaceProvider>
          <div className="flex min-h-screen">
            <Sidebar />
            <main className="flex-1 overflow-auto">
              <header className="sticky top-0 z-10 bg-slate-900/80 backdrop-blur border-b border-slate-700 px-6 py-3 flex items-center justify-between">
                <div />
                <UserBadge />
              </header>
              <div className="p-6">{children}</div>
            </main>
          </div>
        </NamespaceProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
