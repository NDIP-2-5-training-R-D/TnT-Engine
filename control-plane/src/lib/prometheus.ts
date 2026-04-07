/**
 * Prometheus text-format parser.
 * Extracted as a pure utility so it can be unit-tested independently
 * of the Next.js API route.
 */

export interface ParsedMetric {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** Parse Prometheus text exposition format into typed metric samples. */
export function parsePrometheusText(text: string): ParsedMetric[] {
  return text
    .split("\n")
    .map((line): ParsedMetric | null => {
      line = line.trim();
      if (!line || line.startsWith("#")) return null;

      const bracketIdx = line.indexOf("{");
      if (bracketIdx !== -1) {
        const closeBracket = line.indexOf("}");
        if (closeBracket === -1) return null;
        const name = line.slice(0, bracketIdx);
        const labelStr = line.slice(bracketIdx + 1, closeBracket);
        const rest = line.slice(closeBracket + 1).trim().split(/\s+/);
        const value = parseFloat(rest[0]);
        if (isNaN(value)) return null;

        const labels: Record<string, string> = {};
        labelStr.split(",").forEach((pair) => {
          const eqIdx = pair.indexOf("=");
          if (eqIdx === -1) return;
          const k = pair.slice(0, eqIdx).trim();
          const v = pair.slice(eqIdx + 1).trim().replace(/^"|"$/g, "");
          labels[k] = v;
        });
        return { name, labels, value };
      }

      const parts = line.split(/\s+/);
      if (parts.length >= 2) {
        const value = parseFloat(parts[1]);
        if (!isNaN(value)) return { name: parts[0], labels: {}, value };
      }
      return null;
    })
    .filter((m): m is ParsedMetric => m !== null);
}

/** Sum all samples of the named metric across all label combinations. */
export function sumMetric(metrics: ParsedMetric[], name: string): number {
  return metrics
    .filter((m) => m.name === name)
    .reduce((acc, m) => acc + m.value, 0);
}

/** Return the first sample matching name and optional exact label values. */
export function findMetric(
  metrics: ParsedMetric[],
  name: string,
  labelFilter?: Record<string, string>,
): ParsedMetric | undefined {
  return metrics.find((m) => {
    if (m.name !== name) return false;
    if (!labelFilter) return true;
    return Object.entries(labelFilter).every(([k, v]) => m.labels[k] === v);
  });
}

/** Return all samples of a metric grouped by a specific label value. */
export function groupByLabel(
  metrics: ParsedMetric[],
  name: string,
  labelKey: string,
): Record<string, number> {
  const result: Record<string, number> = {};
  metrics
    .filter((m) => m.name === name)
    .forEach((m) => {
      const key = m.labels[labelKey] ?? "unknown";
      result[key] = (result[key] ?? 0) + m.value;
    });
  return result;
}
