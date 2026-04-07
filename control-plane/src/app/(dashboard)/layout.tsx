/**
 * Dashboard layout — renders Sidebar + top header for all authenticated pages.
 */
import Sidebar from "@/components/layout/Sidebar";
import UserBadge from "@/components/layout/UserBadge";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
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
  );
}
