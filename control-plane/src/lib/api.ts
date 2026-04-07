"use client";

// SWR-based hooks for data fetching from BFF API routes.
// All requests go to Next.js API routes (server-side) — never directly to Vault.

import useSWR from "swr";
import type {
  HealthData, MetricsData, TransitKeyInfo,
  PolicyListItem, PolicyInfo, AppRoleInfo,
  MutationResponse, SecretIdResponse,
  SealStatusData, UnsealResponse, InitResponse, HsmStatus,
} from "./types";

const fetcher = (url: string) => fetch(url).then((r) => {
  if (!r.ok) throw new Error(`API error: ${r.status}`);
  return r.json();
});

// ── Health & Metrics ───────────────────────────────────────────────

export function useHealth() {
  return useSWR<HealthData>("/api/health", fetcher, {
    refreshInterval: 5_000,
    revalidateOnFocus: true,
  });
}

export function useMetrics() {
  return useSWR<MetricsData>("/api/metrics", fetcher, { refreshInterval: 15_000 });
}

export function useAuditLog(limit: number = 20) {
  return useSWR(`/api/audit?limit=${limit}`, fetcher, { refreshInterval: 10_000 });
}

// ── Key Lifecycle Management ───────────────────────────────────────

export function useTransitKeys() {
  return useSWR<TransitKeyInfo[]>("/api/keys", fetcher, { refreshInterval: 30_000 });
}

export async function rotateKey(keyName: string): Promise<MutationResponse> {
  const res = await fetch("/api/keys/rotate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Confirm-Action": "ROTATE",
    },
    body: JSON.stringify({ key_name: keyName, confirm: `ROTATE-${keyName}` }),
  });
  if (!res.ok && res.headers.get("content-type")?.includes("application/json") === false) {
    return { success: false, message: `Server error: HTTP ${res.status}` };
  }
  return res.json();
}

export async function downloadBackup(): Promise<Blob> {
  const res = await fetch("/api/keys/backup", { method: "POST" });
  if (!res.ok) throw new Error(`Backup failed: ${res.status}`);
  return res.blob();
}

// ── Policies ───────────────────────────────────────────────────────

export function usePolicies() {
  return useSWR<PolicyListItem[]>("/api/policies", fetcher, { refreshInterval: 30_000 });
}

export function usePolicy(name: string) {
  return useSWR<PolicyInfo>(name ? `/api/policies?name=${name}` : null, fetcher);
}

export async function savePolicy(
  name: string,
  capabilities: { path: string; capabilities: string[] }[]
): Promise<MutationResponse> {
  const res = await fetch("/api/policies", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Confirm-Action": "POLICY",
    },
    body: JSON.stringify({ name, capabilities }),
  });
  return res.json();
}

// ── AppRole Provisioning ───────────────────────────────────────────

export function useAppRoles() {
  return useSWR<AppRoleInfo[]>("/api/approles", fetcher, { refreshInterval: 30_000 });
}

export async function generateSecretId(roleName: string): Promise<SecretIdResponse> {
  const res = await fetch("/api/approles", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Confirm-Action": "GENERATE",
    },
    body: JSON.stringify({ role_name: roleName, action: "generate_secret_id" }),
  });
  return res.json();
}

// ── Seal / Unseal Operations ───────────────────────────────────────

export function useSealStatus() {
  return useSWR<SealStatusData>("/api/unseal", fetcher, {
    refreshInterval: 3_000,
    revalidateOnFocus: true,
  });
}

export async function submitUnsealShard(key: string, reason: string): Promise<UnsealResponse> {
  const res = await fetch("/api/unseal", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Confirm-Action": "UNSEAL",
    },
    body: JSON.stringify({ key, reason }),
  });
  return res.json();
}

export async function initializeVault(shares: number, threshold: number): Promise<InitResponse> {
  const res = await fetch("/api/init", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Confirm-Action": "INIT",
    },
    body: JSON.stringify({ secret_shares: shares, secret_threshold: threshold }),
  });
  return res.json();
}

// ── HSM Status ─────────────────────────────────────────────────────

export function useHsmStatus() {
  return useSWR<HsmStatus>("/api/hsm", fetcher, { refreshInterval: 10_000 });
}

// ── Emergency ──────────────────────────────────────────────────────

export async function sealVault(confirmPhrase: string): Promise<MutationResponse> {
  const res = await fetch("/api/emergency/seal", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Confirm-Action": "SEAL",
    },
    body: JSON.stringify({ confirm: confirmPhrase }),
  });
  return res.json();
}
