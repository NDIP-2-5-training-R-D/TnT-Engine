// BFF: Server-Sent Events — real-time Control Plane action stream
//
// GET /api/events
//
// Streams CpEvent objects as SSE whenever a mutative CP action completes
// (key rotate, seal, policy create, approval, backup, etc.).
//
// Client usage:
//   const es = new EventSource("/api/events");
//   es.onmessage = (e) => { const event = JSON.parse(e.data); ... };
//
// RBAC: any authenticated user can subscribe (read-only stream)

export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { subscribeCpEvent, type CpEvent } from "@/lib/event-bus";

const HEARTBEAT_INTERVAL_MS = 20_000; // keep connection alive through proxies

export async function GET(request: NextRequest) {
  // RBAC
  const { requireAuth } = await import("@/lib/rbac");
  const auth = await requireAuth(request);
  if (auth.error) return auth.error;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Send initial connection event
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: "CONNECTED", performed_by: auth.user?.username ?? "unknown", result: "success", timestamp: new Date().toISOString() })}\n\n`)
      );

      // Forward CP events to this SSE client
      const unsubscribe = subscribeCpEvent((event: CpEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // Client disconnected — unsubscribe handled below
        }
      });

      // Heartbeat to keep the connection alive through load balancers / nginx
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          clearInterval(heartbeat);
        }
      }, HEARTBEAT_INTERVAL_MS);

      // Cleanup on client disconnect
      request.signal.addEventListener("abort", () => {
        unsubscribe();
        clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no", // disable nginx response buffering
    },
  });
}
