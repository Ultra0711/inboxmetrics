import { db, withDbRetry } from "@/db";
import { emailMetrics, emailEvents, labels } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

const METRIC_KEYS = [
  "inbox", "received", "sent", "drafts", "spam", "trash", "starred",
  "important", "attachments", "labels", "scheduled", "unread", "read",
];

export async function GET() {
  try {
    // Wrapped as one retryable unit: the Supabase pooler occasionally drops
    // the connection mid-handshake, and without a retry that surfaced to the
    // dashboard as "no data yet" even though the DB still has everything.
    const result = await withDbRetry(async () => {
      // Last 5 syncs per metric type, so the sparkline has real points once
      // a few cron runs have happened. Falls back gracefully if there's only 1.
      const metrics: Record<string, { value: number; prev: number; change: number; sparkline: number[] }> = {};

      for (const key of METRIC_KEYS) {
        const rows = await db
          .select()
          .from(emailMetrics)
          .where(eq(emailMetrics.metricType, key))
          .orderBy(desc(emailMetrics.timestamp))
          .limit(5);

        if (rows.length === 0) {
          metrics[key] = { value: 0, prev: 0, change: 0, sparkline: [0, 0] };
          continue;
        }

        const latest = rows[0];
        const change = latest.previousValue > 0
          ? ((latest.value - latest.previousValue) / latest.previousValue) * 100
          : 0;

        metrics[key] = {
          value: latest.value,
          prev: latest.previousValue,
          change: Math.round(change * 10) / 10,
          sparkline: rows.map((r) => r.value).reverse(),
        };
      }

      // Matches the sync route's fetch size (200) — reading fewer than were
      // stored would silently cap date-range filters (This Month, Last 90
      // Days, etc.) back down to whatever this limit allowed, even after
      // the sync itself had real history to offer.
      const eventRows = await db
        .select()
        .from(emailEvents)
        .orderBy(desc(emailEvents.timestamp))
        .limit(200);

      const events = eventRows.map((e) => ({
        id: e.id,
        type: e.type,
        subject: e.subject ?? "(no subject)",
        from: e.fromEmail ?? "",
        timestamp: e.timestamp.toISOString(),
        label: e.label ?? "Inbox",
        read: e.isRead ?? false,
      }));

      // Approximate hourly activity chart from real event timestamps (hour-of-day buckets).
      const activity = Array.from({ length: 24 }, (_, hour) => ({ hour, sent: 0, received: 0, replies: 0 }));
      for (const e of eventRows) {
        const hour = e.timestamp.getHours();
        if (e.type === "sent") activity[hour].sent += 1;
        else if (e.type === "received") activity[hour].received += 1;
      }

      const labelRows = await db.select().from(labels).orderBy(desc(labels.count));

      const hasAnyData = eventRows.length > 0 || Object.values(metrics).some((m) => m.value > 0);

      return {
        metrics,
        events,
        activity,
        labels: labelRows.map((l) => ({ name: l.name, count: l.count, color: l.color })),
        hasAnyData,
      };
    });

    return Response.json({ ok: true, ...result });
  } catch (err) {
    console.error("dashboard-data failed", err);
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
