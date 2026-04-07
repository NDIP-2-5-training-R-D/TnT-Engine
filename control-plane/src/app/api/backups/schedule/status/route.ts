// GET /api/backups/schedule/status
//
// Returns the current schedule config enriched with:
//   - computed cron_expression string ("every N hours")
//   - is_overdue flag
//   - seconds_until_next countdown
//
// Requires any authenticated role (admin | operator | viewer).

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getSchedule, computeNextRun } from "@/lib/backup-store";

export async function GET(request: NextRequest) {
  const { requireAuth } = await import("@/lib/rbac");
  const auth = await requireAuth(request);
  if (auth.error) return auth.error;

  const schedule = getSchedule();
  const now = Date.now();

  // Derive next_run_at — use stored value if present, otherwise compute it
  const nextRunAt: string | null =
    schedule.next_run_at ?? computeNextRun(schedule);

  // Derive is_overdue and seconds_until_next
  let isOverdue = false;
  let secondsUntilNext: number | null = null;

  if (nextRunAt !== null) {
    const nextMs = Date.parse(nextRunAt);
    const diffMs = nextMs - now;
    isOverdue = schedule.enabled && diffMs < 0;
    secondsUntilNext = Math.round(diffMs / 1000);
  }

  // Human-readable cron expression for display
  const h = schedule.interval_hours;
  const cronDisplay =
    h === 1  ? "0 * * * *"      :   // every hour
    h === 24 ? "0 0 * * *"      :   // every day at midnight
               `0 */${h} * * *`;    // every N hours

  return NextResponse.json({
    enabled:          schedule.enabled,
    interval_hours:   schedule.interval_hours,
    retention_count:  schedule.retention_count,
    cron_expression:  cronDisplay,
    last_run_at:      schedule.last_run_at    ?? null,
    last_run_status:  schedule.last_run_status ?? null,
    next_run_at:      nextRunAt,
    is_overdue:       isOverdue,
    seconds_until_next: secondsUntilNext,
  });
}
