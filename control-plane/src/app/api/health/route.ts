// BFF: Health status aggregator
// Probes each infrastructure service INDEPENDENTLY:
//   - OpenBao: /v1/sys/health (unauthenticated)
//   - T&T Engine: /api/v1/health
//   - PostgreSQL: TCP connect on port 5432
//   - Redis: TCP connect on port 6379
//   - Kafka: TCP connect on port 9092 (audit durability sink)
//
// NEVER returns tokens, cluster IDs, or internal topology to the client.

import { NextResponse } from "next/server";
import { createConnection } from "net";

const VAULT_ADDR = process.env.VAULT_ADDR || "http://localhost:8200";
const TNT_URL = process.env.TNT_ENGINE_URL || "http://localhost:8000";
const PG_HOST = process.env.PG_HOST || "localhost";
const PG_PORT = parseInt(process.env.PG_PORT || "5432", 10);
const REDIS_HOST = process.env.REDIS_HOST || "localhost";
const REDIS_PORT = parseInt(process.env.REDIS_PORT || "6379", 10);
const KAFKA_HOST = process.env.KAFKA_HOST || "localhost";
const KAFKA_PORT = parseInt(process.env.KAFKA_PORT || "9092", 10);

/** TCP connectivity check with timeout */
function tcpProbe(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: timeoutMs });
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.on("error", () => { socket.destroy(); resolve(false); });
  });
}

// Disable Next.js Route Handler caching — health must always be live
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const timestamp = new Date().toISOString();

  // 1. OpenBao health (non-authenticated endpoint)
  let vault = { status: "unreachable" as string, initialized: false, sealed: true, version: "" };
  try {
    const res = await fetch(`${VAULT_ADDR}/v1/sys/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    const body = await res.json();
    vault = {
      status: res.status === 200 ? "healthy"
            : res.status === 429 ? "standby"
            : res.status === 503 ? "sealed"
            : "uninitialized",
      initialized: body.initialized ?? false,
      sealed: body.sealed ?? true,
      version: body.version ?? "",
    };
  } catch {
    vault.status = "unreachable";
  }

  // 2. T&T Engine health
  let engine = { status: "unreachable", circuit_breaker: "UNKNOWN", l1_cache_size: 0 };
  try {
    const res = await fetch(`${TNT_URL}/api/v1/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const body = await res.json();
      engine = {
        status: body.status ?? "unknown",
        circuit_breaker: body.circuit_breaker ?? "UNKNOWN",
        l1_cache_size: body.l1_cache_size ?? 0,
      };
    }
  } catch {
    engine.status = "unreachable";
  }

  // 3. PostgreSQL — direct TCP probe (independent of T&T Engine)
  const pgConnected = await tcpProbe(PG_HOST, PG_PORT);

  // 4. Redis — direct TCP probe (independent of T&T Engine)
  const redisConnected = await tcpProbe(REDIS_HOST, REDIS_PORT);

  // 5. Kafka — direct TCP probe on the broker listener.
  //    Doesn't speak the protocol, but proves the broker port is accepting
  //    connections; a full Kafka health API call would require the admin
  //    client and a long-lived producer, which we don't run in the BFF.
  const kafkaConnected = await tcpProbe(KAFKA_HOST, KAFKA_PORT);

  return NextResponse.json({
    vault,
    engine,
    postgres: { connected: pgConnected },
    redis: { connected: redisConnected },
    kafka: { connected: kafkaConnected },
    timestamp,
  });
}
