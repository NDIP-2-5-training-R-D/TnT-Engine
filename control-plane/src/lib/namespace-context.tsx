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

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";

interface NamespaceContextValue {
  namespace: string;           // Current namespace ("root" = default)
  setNamespace: (ns: string) => void;
  namespaces: string[];        // Available namespaces
  isRoot: boolean;
  refresh: () => Promise<void>; // Re-fetch namespace list from server
}

const NamespaceContext = createContext<NamespaceContextValue>({
  namespace: "root",
  setNamespace: () => {},
  namespaces: ["root"],
  isRoot: true,
  refresh: async () => {},
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

  const fetchNamespaces = useCallback(async () => {
    try {
      const r = await fetch("/api/namespaces");
      const data = await r.json();
      if (data.namespaces?.length) setNamespaces(data.namespaces);
    } catch {}
  }, []);

  // Load from localStorage and fetch available namespaces on mount
  useEffect(() => {
    const saved = localStorage.getItem("tnt-namespace");
    if (saved) setNamespaceState(saved);
    fetchNamespaces();
  }, [fetchNamespaces]);

  const setNamespace = (ns: string) => {
    setNamespaceState(ns);
    localStorage.setItem("tnt-namespace", ns);
  };

  return (
    <NamespaceContext.Provider
      value={{
        namespace,
        setNamespace,
        namespaces,
        isRoot: namespace === "root",
        refresh: fetchNamespaces,
      }}
    >
      {children}
    </NamespaceContext.Provider>
  );
}
