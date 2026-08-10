# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev         # start dev server (Next.js, Turbopack)
npm run build        # production build
npm run lint          # eslint .
npm run typecheck     # tsc --noEmit

npx drizzle-kit generate   # generate SQL migration from src/db/schema.ts
npx drizzle-kit push       # push schema changes directly to DATABASE_URL (no migration files)
npx drizzle-kit studio     # browse the DB
```

There is no test suite in this repo currently.

Local setup: copy `.env.example` to `.env.local` and fill in `DATABASE_URL` (Postgres — Neon/Supabase/Railway), `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (Google Cloud OAuth client), `NEXTAUTH_SECRET` (`npx auth secret`), `NEXTAUTH_URL`, and `CRON_SECRET` (any string, used to authenticate Vercel Cron requests).

## Architecture

InboxMetrics is a single-user Gmail analytics dashboard: Next.js App Router + NextAuth (Google OAuth, Gmail readonly scope) + Postgres via Drizzle ORM, deployed on Vercel with Vercel Cron driving the sync.

**Data flow is entirely pull-based from Gmail into Postgres, then the dashboard just reads Postgres:**

1. **Auth** ([src/auth.ts](src/auth.ts)) — NextAuth Google provider requests `gmail.readonly` with `access_type: offline` + `prompt: consent` to force a refresh token. On each sign-in, the `jwt` callback persists the refresh token into the single-row-per-login `gmail_auth` table (there's no user table — this app is built for one Gmail account, not multi-tenant).

2. **Sync** ([src/app/api/cron/sync-gmail/route.ts](src/app/api/cron/sync-gmail/route.ts)) — the one place that talks to the Gmail API. Loads the most recent refresh token from `gmail_auth`, builds an OAuth2 client, and pulls two kinds of KPIs:
   - `SYSTEM_LABEL_METRICS`: direct `labels.get` calls for Gmail's system labels (INBOX, UNREAD, DRAFT, SPAM, TRASH, STARRED, IMPORTANT).
   - `SEARCH_METRICS`: `messages.list` with a search query, reading `resultSizeEstimate` (received/sent today, attachments) — no pagination, just the estimate.

   Each sync run inserts one new row per metric into `email_metrics`, carrying forward the prior value as `previousValue` (looked up from the last 200 rows) so the dashboard can compute % change without a separate "previous" query. It also fetches the last 20 messages and upserts them into `email_events` (`onConflictDoNothing` keyed on `gmailMessageId`) to back the Live Activity Feed.

   This route is triggered two ways, and treats both identically: Vercel Cron (per `vercel.json`, 7:00/18:00 UTC — described in the UI as "8:00 AM & 7:00 PM WAT"), authenticated via `Authorization: Bearer $CRON_SECRET`; and the dashboard's "Sync Now" button doing a plain `fetch`. Auth check is skipped if `CRON_SECRET` isn't set.

3. **Read** ([src/app/api/dashboard-data/route.ts](src/app/api/dashboard-data/route.ts)) — never touches Gmail. For each key in `METRIC_KEYS`, reads the last 5 `email_metrics` rows to build `{ value, prev, change, sparkline }`, reads the last 20 `email_events` for the feed, buckets events into 24 hour-of-day activity counts, and reads `campaigns`. `hasAnyData` tells the frontend whether to show the "connect/sync" empty state instead of a zeroed dashboard.

4. **UI** ([src/app/page.tsx](src/app/page.tsx)) — single client component, no sub-components. Loads `/api/dashboard-data` on mount; "Sync Now" hits `/api/cron/sync-gmail` then reloads. `METRIC_KEYS` here must stay in sync with the same constant in the dashboard-data route. Note: `scheduled` is a wired-up metric key with no producer in the sync route (always reads as empty/zero) and the Labels tab / label filter chips use client-side random counts (`labelCounts`), not real data — these are known gaps, not bugs to silently "fix" by inventing data.

**Schema** ([src/db/schema.ts](src/db/schema.ts)): `email_metrics` (time series, one row per metric per sync), `email_events` (individual Gmail messages), `labels` and `campaigns` (defined but not populated by the sync route — campaigns has no writer at all), `gmail_auth` (refresh token storage, append-only — sync always queries `orderBy(desc(updatedAt)).limit(1)` for the latest).

**DB access**: [src/db/index.ts](src/db/index.ts) exports a single `db` (Drizzle) and `pool` (pg.Pool), memoized on `globalThis` outside production to survive Next.js hot-reload without exhausting connections. Both API routes and `auth.ts` import `db` directly — no repository/service layer.

**Path alias**: `@/*` → `src/*`.
