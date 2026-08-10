import { google, gmail_v1 } from "googleapis";
import { db } from "@/db";
import { emailMetrics, emailEvents, gmailAuth, labels } from "@/db/schema";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

// Gmail's built-in system labels map directly onto most of the dashboard's KPIs.
const SYSTEM_LABEL_METRICS: { metricType: string; labelId: string; field: "messagesTotal" | "messagesUnread" }[] = [
  { metricType: "inbox", labelId: "INBOX", field: "messagesTotal" },
  { metricType: "unread", labelId: "UNREAD", field: "messagesUnread" },
  { metricType: "drafts", labelId: "DRAFT", field: "messagesTotal" },
  { metricType: "spam", labelId: "SPAM", field: "messagesTotal" },
  { metricType: "trash", labelId: "TRASH", field: "messagesTotal" },
  { metricType: "starred", labelId: "STARRED", field: "messagesTotal" },
  { metricType: "important", labelId: "IMPORTANT", field: "messagesTotal" },
];

// A few KPIs aren't a plain label lookup — they're a date-scoped search.
// resultSizeEstimate is Gmail's own count for a search, no pagination needed.
const SEARCH_METRICS: { metricType: string; query: string }[] = [
  { metricType: "received", query: "in:inbox newer_than:1d" },
  { metricType: "sent", query: "in:sent newer_than:1d" },
  { metricType: "attachments", query: "has:attachment" },
];

/**
 * Triggered two ways:
 *  1. Vercel Cron, per the schedules in vercel.json (8:00 AM / 7:00 PM WAT).
 *     Vercel signs these requests with an Authorization: Bearer <CRON_SECRET>
 *     header and an x-vercel-cron header — only those requests need to pass
 *     the CRON_SECRET check below.
 *  2. The "Sync Now" button in the dashboard, for an on-demand refresh. It's
 *     a same-origin browser fetch with no Authorization header, so it must
 *     not be blocked by the cron check.
 */
export async function GET(request: Request) {
  const isVercelCronRequest = request.headers.has("x-vercel-cron");

  if (isVercelCronRequest && process.env.CRON_SECRET) {
    const authHeader = request.headers.get("authorization");
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  try {
    const [tokenRow] = await db
      .select()
      .from(gmailAuth)
      .orderBy(desc(gmailAuth.updatedAt))
      .limit(1);

    if (!tokenRow) {
      return Response.json(
        { ok: false, error: "No Gmail account connected yet — sign in at /api/auth/signin first." },
        { status: 400 }
      );
    }

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    oauth2Client.setCredentials({ refresh_token: tokenRow.refreshToken });
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    // --- 1. Label-based KPIs (inbox, unread, drafts, spam, trash, starred, important) ---
    const labelResults = await Promise.all(
      SYSTEM_LABEL_METRICS.map(async ({ metricType, labelId, field }) => {
        try {
          const res = await gmail.users.labels.get({ userId: "me", id: labelId });
          return { metricType, value: res.data[field] ?? 0 };
        } catch {
          return { metricType, value: 0 };
        }
      })
    );

    // --- 2. Search-based KPIs (received today, sent today, has-attachment) ---
    const searchResults = await Promise.all(
      SEARCH_METRICS.map(async ({ metricType, query }) => {
        try {
          const res = await gmail.users.messages.list({ userId: "me", q: query, maxResults: 1 });
          return { metricType, value: res.data.resultSizeEstimate ?? 0 };
        } catch {
          return { metricType, value: 0 };
        }
      })
    );

    // --- 3. Total messages + custom label count (everything that isn't a system label) ---
    const [profile, allLabels] = await Promise.all([
      gmail.users.getProfile({ userId: "me" }),
      gmail.users.labels.list({ userId: "me" }),
    ]);
    const customLabelCount =
      allLabels.data.labels?.filter((l) => l.type === "user").length ?? 0;

    // --- Real per-label counts for the Labels tab (replaces the old random placeholder). ---
    // labels.list does NOT return messagesTotal (verified against the live
    // API) — only labels.get does, per label. Fetching every user label
    // individually; skipping noisy system labels (CHAT, CATEGORY_*, etc.)
    // that clutter the tab without being useful KPIs on their own.
    // Snapshot semantics: each sync replaces the table with the current
    // counts, since Gmail's label counts are point-in-time, not a time series.
    const customLabels = (allLabels.data.labels ?? []).filter((l) => l.type === "user" && l.id);
    const customLabelDetails = await Promise.all(
      customLabels.map(async (l) => {
        try {
          const res = await gmail.users.labels.get({ userId: "me", id: l.id! });
          return { name: res.data.name ?? l.id!, count: res.data.messagesTotal ?? 0 };
        } catch {
          return null;
        }
      })
    );

    const labelRows = [
      // System labels already fetched above via labels.get for the KPI cards —
      // reuse those counts instead of making duplicate API calls.
      ...SYSTEM_LABEL_METRICS.map(({ metricType, labelId }) => ({
        name: labelId,
        count: labelResults.find((r) => r.metricType === metricType)?.value ?? 0,
        color: "#3b82f6",
      })),
      ...customLabelDetails
        .filter((l): l is { name: string; count: number } => l !== null)
        .map((l) => ({ name: l.name, count: l.count, color: "#8b5cf6" })),
    ];

    const inboxCount = labelResults.find((r) => r.metricType === "inbox")?.value ?? 0;
    const unreadCount = labelResults.find((r) => r.metricType === "unread")?.value ?? 0;

    const allMetrics = [
      ...labelResults,
      ...searchResults,
      { metricType: "labels", value: customLabelCount },
      { metricType: "read", value: Math.max(0, inboxCount - unreadCount) },
    ];

    // Carry forward the previous value for each metric so the dashboard can show % change.
    const previous = await db.select().from(emailMetrics).orderBy(desc(emailMetrics.timestamp)).limit(200);
    const previousByType = new Map<string, number>();
    for (const row of previous) {
      if (!previousByType.has(row.metricType)) previousByType.set(row.metricType, row.value);
    }

    await db.insert(emailMetrics).values(
      allMetrics.map((m) => ({
        metricType: m.metricType,
        value: m.value,
        previousValue: previousByType.get(m.metricType) ?? m.value,
        metadata: { source: "gmail-api" },
      }))
    );

    // --- 4. Recent messages as real events for the Live Activity Feed and
    // date-range filters (This Month, Last 90 Days, etc). 20 was too small —
    // every sync only ever covered the last couple of days, so wider ranges
    // and All-time all looked identical. 200 gives filters real history to
    // work with; onConflictDoNothing means repeat syncs only add newly-seen
    // messages, so this accumulates real history over time rather than
    // re-fetching the same window.
    const recent = await gmail.users.messages.list({ userId: "me", maxResults: 200 });
    const messageIds = recent.data.messages ?? [];

    const detailed = await Promise.all(
      messageIds.map((m) =>
        gmail.users.messages.get({
          userId: "me",
          id: m.id!,
          format: "metadata",
          metadataHeaders: ["Subject", "From"],
        })
      )
    );

    const getHeader = (msg: gmail_v1.Schema$Message, name: string) =>
      msg.payload?.headers?.find((h) => h.name === name)?.value ?? "";

    const eventsToInsert = detailed.map((res) => {
      const msg = res.data;
      const labelIds = msg.labelIds ?? [];
      return {
        gmailMessageId: msg.id ?? undefined,
        type: labelIds.includes("SENT") ? "sent" : labelIds.includes("DRAFT") ? "draft" : "received",
        subject: getHeader(msg, "Subject") || "(no subject)",
        fromEmail: getHeader(msg, "From"),
        timestamp: msg.internalDate ? new Date(Number(msg.internalDate)) : new Date(),
        label: labelIds[0] ?? "Inbox",
        isRead: !labelIds.includes("UNREAD"),
      };
    });

    if (eventsToInsert.length > 0) {
      await db.insert(emailEvents).values(eventsToInsert).onConflictDoNothing();
    }

    // Replace the label snapshot wholesale — Gmail's counts are current-state,
    // not deltas, so there's nothing meaningful to preserve from the last sync.
    await db.delete(labels);
    if (labelRows.length > 0) {
      await db.insert(labels).values(labelRows);
    }

    return Response.json({ ok: true, syncedAt: new Date().toISOString(), metricsWritten: allMetrics.length, eventsWritten: eventsToInsert.length, labelsWritten: labelRows.length });
  } catch (err) {
    console.error("sync-gmail failed", err);
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
