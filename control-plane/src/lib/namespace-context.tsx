"use client";

/**
 * Namespace Context — provides the currently selected OpenBao namespace
 * to all components and API calls.
 *
 * The selected namespace is persisted in localStorage and sent as a
 * query parameter to BFF API routes, which add the X-Vault-Namespace header.
 *
 * "root" means no namespace (default OpenBao behavior).
 */

import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

interface NamespaceContextValue {
  namespace: string;           // Current namespace ("root" = default)
  setNamespace: (ns: string) => void;
  namespaces: string[];        // Available namespaces
  isRoot: boolean;
}

const NamespaceContext = createContext<NamespaceContextValue>({
  namespace: "root",
  setNamespace: () => {},
  namespaces: ["root"],
  isRoot: true,
});

export function useNamespace() {
  return useContext(NamespaceContext);
}

/** Returns namespace query param for API calls. Empty string if root. */
export function namespaceParam(ns: string): string {
  return ns && ns !== "root" ? `&namespace=${encodeURIComponent(ns)}` : "";
}

export function NamespaceProvider({ children }: { children: ReactNode }) {
  const [namespace, setNamespaceState] = useState("root");
  const [namespaces, setNamespaces] = useState(["root"]);

  // Load from localStorage
  useEffect(() => {
    const saved = localStorage.getItem("tnt-namespace");
    if (saved) setNamespaceState(saved);

    // Fetch available namespaces from API
    fetch("/api/namespaces")
      .then((r) => r.json())
      .then((data) => {
        if (data.namespaces?.length) setNamespaces(data.namespaces);
      })
      .catch(() => {});
  }, []);

  const setNamespace = (ns: string) => {
    setNamespaceState(ns);
    localStorage.setItem("tnt-namespace", ns);
  };

  return (
    <NamespaceContext.Provider
      value={{ namespace, setNamespace, namespaces, isRoot: namespace === "root" }}
    >
      {children}
    </NamespaceContext.Provider>
  );
}
