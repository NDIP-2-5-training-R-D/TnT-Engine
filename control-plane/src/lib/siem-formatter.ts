/**
 * SIEM Log Formatters — transforms audit events to external formats.
 *
 * Supported formats:
 *   - CEF (Common Event Format) — ArcSight, Splunk, QRadar
 *   - JSON-SIEM — Elasticsearch, Datadog, Grafana Loki
 *
 * CEF Format:
 *   CEF:0|TNT-Engine|ControlPlane|1.0|<action>|<name>|<severity>|<extensions>
 *
 * Severity mapping:
 *   DELETE/REVOKE/SEAL → 8 (High)
 *   ROTATE/INIT/UNSEAL → 5 (Medium)
 *   TOKENIZE/DETOKENIZE → 3 (Low)
 *   VIEW/QUERY → 1 (Info)
 */

export interface AuditEvent {
  id?: number;
  action: string;
  field?: string | null;
  tenant_id: string;
  trace_id?: string | null;
  status: string;
  performed_at: string;
  user?: string;
  user_role?: string;
  source_ip?: string;
  metadata?: Record<string, unknown>;
}

// ── Severity Mapping ───────────────────────────────────────────────

const SEVERITY_MAP: Record<string, number> = {
  DELETE: 8, REVOKE: 8, SEAL: 8,
  ROTATE: 5, INIT: 5, UNSEAL: 5, REENCRYPT: 5,
  TOKENIZE: 3, DETOKENIZE: 3, BATCH_TOKENIZE: 3, BATCH_DETOKENIZE: 3,
  MASK: 2, HASH: 2,
};

function getSeverity(action: string): number {
  return SEVERITY_MAP[action.toUpperCase()] ?? 1;
}

function getSeverityLabel(severity: number): string {
  if (severity >= 8) return "High";
  if (severity >= 5) return "Medium";
  if (severity >= 3) return "Low";
  return "Info";
}

// ── CEF Formatter ──────────────────────────────────────────────────

function escapeCef(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/=/g, "\\=");
}

export function toCEF(event: AuditEvent): string {
  const severity = getSeverity(event.action);
  const extensions = [
    `rt=${new Date(event.performed_at).getTime()}`,
    `act=${escapeCef(event.action)}`,
    `duser=${escapeCef(event.user || "system")}`,
    `cs1=${escapeCef(event.tenant_id)}`,
    `cs1Label=TenantID`,
    `outcome=${escapeCef(event.status)}`,
  ];

  if (event.trace_id) extensions.push(`cs2=${escapeCef(event.trace_id)}`, `cs2Label=TraceID`);
  if (event.field) extensions.push(`cs3=${escapeCef(event.field)}`, `cs3Label=FieldType`);
  if (event.user_role) extensions.push(`cs4=${escapeCef(event.user_role)}`, `cs4Label=UserRole`);
  if (event.source_ip) extensions.push(`src=${escapeCef(event.source_ip)}`);

  return `CEF:0|TNT-Engine|ControlPlane|1.0|${event.action}|${event.action} operation|${severity}|${extensions.join(" ")}`;
}

// ── JSON-SIEM Formatter (ECS-compatible) ───────────────────────────

export function toSIEMJson(event: AuditEvent): object {
  const severity = getSeverity(event.action);
  return {
    "@timestamp": event.performed_at,
    "event.kind": "event",
    "event.category": "authentication",
    "event.type": event.status === "success" ? "allowed" : "denied",
    "event.action": event.action.toLowerCase(),
    "event.outcome": event.status,
    "event.severity": severity,
    "event.severity_label": getSeverityLabel(severity),
    "event.module": "tnt-engine",
    "event.dataset": "tnt-engine.audit",
    "observer.name": "tnt-control-plane",
    "observer.type": "control-plane",
    "user.name": event.user || "system",
    "user.roles": event.user_role ? [event.user_role] : [],
    "source.ip": event.source_ip || "",
    "tnt.tenant_id": event.tenant_id,
    "tnt.trace_id": event.trace_id || "",
    "tnt.field_type": event.field || "",
    "tnt.action": event.action,
    ...(event.metadata && Object.keys(event.metadata).length > 0
      ? { "tnt.metadata": event.metadata }
      : {}),
  };
}

// ── Batch Formatters ───────────────────────────────────────────────

export function batchToCEF(events: AuditEvent[]): string {
  return events.map(toCEF).join("\n");
}

export function batchToSIEMJson(events: AuditEvent[]): object[] {
  return events.map(toSIEMJson);
}
