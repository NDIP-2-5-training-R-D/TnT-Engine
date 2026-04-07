// BFF: Raft Member Management API
//
// GET:    Returns merged cluster state from raft/configuration, autopilot/state, and sys/health.
//         Any authenticated user may view.
// DELETE: Remove a peer from the cluster. Admin only.
//         Body: { server_id: string }

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";

const VAULT_ADDR  = process.env.VAULT_ADDR  || "http://localhost:8200";
const VAULT_TOKEN = process.env.VAULT_TOKEN || "";

// ── Types ──────────────────────────────────────────────────────────────────

interface RaftMember {
  id: string;
  address: string;
  voter: boolean;
  leader: boolean;
  healthy: boolean;
  last_contact?: string;
  node_status?: string;
}

interface RaftStateResponse {
  members: RaftMember[];
  cluster_name: string;
  cluster_id: string;
  leader_address: string;
  healthy: boolean;
  failure_tolerance: number;
  total_voters: number;
  source: "live" | "error";
  error?: string;
}

// ── Vault fetch helper ─────────────────────────────────────────────────────

async function vaultGet(path: string): Promise<{ ok: boolean; data: any }> {
  try {
    const res = await fetch(`${VAULT_ADDR}${path}`, {
      headers: { "X-Vault-Token": VAULT_TOKEN },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { ok: false, data: null };
    const json = await res.json();
    return { ok: true, data: json };
  } catch {
    return { ok: false, data: null };
  }
}

// ── GET ────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { requireAuth } = await import("@/lib/rbac");
  const auth = await requireAuth(request);
  if (auth.error) return auth.error;

  // Concurrent calls to all three Vault endpoints
  const [configResult, autopilotResult, healthResult] = await Promise.all([
    vaultGet("/v1/sys/storage/raft/configuration"),
    vaultGet("/v1/sys/storage/raft/autopilot/state"),
    vaultGet("/v1/sys/health"),
  ]);

  // If configuration endpoint is completely unavailable, return error state
  if (!configResult.ok) {
    return NextResponse.json({
      members: [],
      cluster_name: "",
      cluster_id: "",
      leader_address: "",
      healthy: false,
      failure_tolerance: 0,
      total_voters: 0,
      source: "error",
      error: "Unable to reach OpenBao raft configuration endpoint",
    } satisfies RaftStateResponse);
  }

  // ── Parse raft/configuration ──────────────────────────────────────
  // Vault may return servers at data.config.servers or data.servers
  const configData = configResult.data?.data ?? {};
  const rawServers: Array<{ id: string; address: string; voter: boolean; leader: boolean }> =
    configData?.config?.servers ?? configData?.servers ?? [];

  // ── Parse autopilot/state ─────────────────────────────────────────
  const autopilotData = autopilotResult.ok ? (autopilotResult.data?.data ?? {}) : {};
  const autopilotServers: Record<string, {
    id: string;
    name?: string;
    address?: string;
    nodeStatus?: string;
    lastContact?: string;
    healthy?: boolean;
    votingStatus?: string;
  }> = autopilotData?.servers ?? {};
  const autopilotHealthy: boolean   = autopilotData?.healthy       ?? true;
  const failureTolerance: number    = autopilotData?.failureTolerance ?? 0;
  const autopilotLeader: string     = autopilotData?.leader         ?? "";

  // ── Parse sys/health ──────────────────────────────────────────────
  const healthData   = healthResult.ok ? healthResult.data : {};
  const clusterName: string = healthData?.cluster_name ?? "";
  const clusterId: string   = healthData?.cluster_id   ?? "";

  // ── Merge members ─────────────────────────────────────────────────
  const members: RaftMember[] = rawServers.map((srv) => {
    const ap = autopilotServers[srv.id];
    return {
      id:           srv.id,
      address:      srv.address,
      voter:        srv.voter,
      leader:       srv.leader,
      healthy:      ap?.healthy       ?? srv.voter, // assume voter == healthy if autopilot missing
      last_contact: ap?.lastContact   ?? (srv.leader ? "0s" : undefined),
      node_status:  ap?.nodeStatus    ?? (srv.voter ? "alive" : undefined),
    };
  });

  // Derive leader address
  const leaderMember = members.find((m) => m.leader);
  const leaderAddress = leaderMember?.address ?? autopilotLeader;

  const totalVoters = members.filter((m) => m.voter).length;

  return NextResponse.json({
    members,
    cluster_name:      clusterName,
    cluster_id:        clusterId,
    leader_address:    leaderAddress,
    healthy:           autopilotResult.ok ? autopilotHealthy : members.every((m) => m.healthy),
    failure_tolerance: failureTolerance,
    total_voters:      totalVoters,
    source:            "live",
  } satisfies RaftStateResponse);
}

// ── DELETE ─────────────────────────────────────────────────────────────────

export async function DELETE(request: NextRequest) {
  const { requireRole } = await import("@/lib/rbac");
  const auth = await requireRole(request, ["admin"]);
  if (auth.error) return auth.error;

  let body: { server_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const serverId = body?.server_id?.trim();
  if (!serverId) {
    return NextResponse.json({ error: "server_id is required" }, { status: 400 });
  }

  // Fetch current configuration to check if target is the leader
  const configResult = await vaultGet("/v1/sys/storage/raft/configuration");
  if (configResult.ok) {
    const configData = configResult.data?.data ?? {};
    const rawServers: Array<{ id: string; address: string; voter: boolean; leader: boolean }> =
      configData?.config?.servers ?? configData?.servers ?? [];

    const target = rawServers.find((s) => s.id === serverId);
    if (target?.leader) {
      return NextResponse.json(
        { error: "Cannot remove the current leader from the cluster", code: "LEADER_REMOVAL_DENIED" },
        { status: 409 }
      );
    }
  }

  // Remove the peer
  try {
    const res = await fetch(`${VAULT_ADDR}/v1/sys/storage/raft/remove-peer`, {
      method: "POST",
      headers: {
        "X-Vault-Token": VAULT_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ server_id: serverId }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      let errMsg = `OpenBao returned HTTP ${res.status}`;
      try {
        const errBody = await res.json();
        errMsg = errBody?.errors?.[0] ?? errMsg;
      } catch { /* ignore */ }
      return NextResponse.json({ error: errMsg }, { status: 502 });
    }

    return NextResponse.json({ success: true, server_id: serverId });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
