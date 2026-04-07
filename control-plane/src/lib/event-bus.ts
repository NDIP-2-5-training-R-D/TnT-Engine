/**
 * Control Plane Event Bus — in-process singleton for SSE broadcasts.
 *
 * Uses a global variable pattern so the singleton survives Next.js
 * hot-module reloads in development without spawning duplicate emitters.
 *
 * Works correctly in persistent Node.js deployments (Docker/K8s via `next start`).
 * Not suitable for serverless/edge runtimes.
 */

import { EventEmitter } from "events";

export interface CpEvent {
  type: string;             // action type, e.g. "KEY_ROTATE"
  performed_by: string;
  target?: string;
  result: "success" | "failure";
  detail?: string;
  timestamp: string;        // ISO
}

// ── Singleton ──────────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __tnt_cp_event_bus: EventEmitter | undefined;
}

const bus: EventEmitter = globalThis.__tnt_cp_event_bus ?? new EventEmitter();
if (!globalThis.__tnt_cp_event_bus) {
  globalThis.__tnt_cp_event_bus = bus;
  bus.setMaxListeners(100); // allow many concurrent SSE clients
}

const EVENT_NAME = "cp:action";

// ── Public API ─────────────────────────────────────────────────────

/** Emit a Control Plane event to all connected SSE clients. */
export function emitCpEvent(event: Omit<CpEvent, "timestamp">): void {
  bus.emit(EVENT_NAME, { ...event, timestamp: new Date().toISOString() } satisfies CpEvent);
}

/** Subscribe to CP events (used by SSE route). Returns unsubscribe function. */
export function subscribeCpEvent(handler: (event: CpEvent) => void): () => void {
  bus.on(EVENT_NAME, handler);
  return () => bus.off(EVENT_NAME, handler);
}
