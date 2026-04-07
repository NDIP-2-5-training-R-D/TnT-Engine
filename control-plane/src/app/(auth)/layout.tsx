/**
 * Auth layout — no sidebar, no header.
 * Used by /login and any future auth pages.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
