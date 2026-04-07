import type { Metadata } from "next";
import "./globals.css";
import SessionProvider from "@/components/layout/SessionProvider";
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
            {children}
          </NamespaceProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
