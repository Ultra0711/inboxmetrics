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

2. **Sync** ([src/app/api/cron/sync-gmail/route.ts](src/app/api/cron/sync-gmail/route.ts)) — the one place that talks to the Gmail API. Loads the most recent refresh token from `gmail_auth`, builds an OAuth2 client, and pulls three kinds of KPIs:
   - `SYSTEM_LABEL_METRICS`: direct `labels.get` calls for Gmail's system labels (INBOX, UNREAD, DRAFT, SPAM, TRASH, STARRED, IMPORTANT).
   - `SEARCH_METRICS`: `messages.list` with a search query, reading `resultSizeEstimate` (received/sent today, attachments) — no pagination, just the estimate.
   - Custom (user-created) label counts: `labels.list` does NOT return `messagesTotal` — only `labels.get` does — so each custom label gets its own `labels.get` call to build real counts for the Labels tab.

   Each sync run inserts one new row per metric into `email_metrics`, carrying forward the prior value as `previousValue` (looked up from the last 200 rows) so the dashboard can compute % change without a separate "previous" query. It also fetches the last **200** messages (bumped up from an original 20 — 20 only ever covered ~2 days of history, which made date-range filters like "This Month"/"Last 90 Days" indistinguishable from "Last 7 Days") and upserts them into `email_events` (`onConflictDoNothing` keyed on `gmailMessageId`, so repeat syncs accumulate real history instead of re-fetching the same window) to back the Live Activity Feed and date-range filters. It also replaces the `labels` table wholesale each sync (`delete` + `insert`) since Gmail's label counts are point-in-time snapshots, not a time series.

   This route is triggered two ways: Vercel Cron (per `vercel.json`, 7:00/18:00 UTC — described in the UI as "8:00 AM & 7:00 PM WAT"), which sends both an `x-vercel-cron` header and `Authorization: Bearer $CRON_SECRET`; and the dashboard's "Sync Now" button, a same-origin browser `fetch` with no Authorization header. The `CRON_SECRET` check only applies when `x-vercel-cron` is present — it used to apply to all requests, which silently 401'd every manual "Sync Now" click whenever `CRON_SECRET` was set locally.

3. **Read** ([src/app/api/dashboard-data/route.ts](src/app/api/dashboard-data/route.ts)) — never touches Gmail. For each key in `METRIC_KEYS`, reads the last 5 `email_metrics` rows to build `{ value, prev, change, sparkline }`, reads the last 200 `email_events` (matches the sync route's fetch size — reading fewer here would silently cap what the frontend's date filters have to work with), buckets events into 24 hour-of-day activity counts, and reads `labels`. `hasAnyData` tells the frontend whether to show the "connect/sync" empty state instead of a zeroed dashboard. The whole handler body is wrapped in `withDbRetry()` ([src/db/index.ts](src/db/index.ts)) — the Supabase pooler intermittently drops the connection mid-handshake, and one retry after a 500ms backoff absorbs most of those instead of surfacing as a false "no data" response.

4. **UI** ([src/app/page.tsx](src/app/page.tsx)) — single client component, no sub-components. Loads `/api/dashboard-data` on mount; "Sync Now" hits `/api/cron/sync-gmail` then reloads. `METRIC_KEYS` here must stay in sync with the same constant in the dashboard-data route. A failed `/api/dashboard-data` load sets a distinct `loadError` state (with a retry banner) rather than silently leaving the dashboard on its zeroed initial state — a fetch failure must never be visually indistinguishable from "genuinely nothing synced yet". `scheduled` is still a wired-up metric key with no producer in the sync route (always reads as empty/zero) and has no per-event data to filter by date — same for `attachments` (the `hasAttachment` column on `email_events` is never populated). Both are known gaps, not bugs to silently "fix" by inventing data. The Campaigns tab/concept was removed entirely (frontend + `campaigns` schema export) since it never had a real data source.

**Theming**: light is the default palette, dark is opt-in via `data-theme="dark"` on `<html>`. Both palettes live as CSS variables in [src/app/globals.css](src/app/globals.css) (`:root` for light, `:root[data-theme="dark"]` for dark) — hand-tuned per mode, not a mechanical inversion. [src/app/layout.tsx](src/app/layout.tsx) has a blocking inline script that sets `data-theme` from `localStorage` (falling back to `prefers-color-scheme`) before hydration, to avoid a flash of the wrong theme. [src/components/theme-toggle.tsx](src/components/theme-toggle.tsx) flips it and persists the choice. All JSX color classes in `page.tsx` reference `var(--...)`, including recharts `stroke`/`fill` props — there should be no hardcoded hex colors left in that file; if you add new UI, follow the same pattern rather than reintroducing literal hex classes.

**Schema** ([src/db/schema.ts](src/db/schema.ts)): `email_metrics` (time series, one row per metric per sync), `email_events` (individual Gmail messages), `labels` (real per-label counts, replaced wholesale each sync), `gmail_auth` (refresh token storage, append-only — sync always queries `orderBy(desc(updatedAt)).limit(1)` for the latest). There is no `campaigns` table anymore — it was dropped from the schema (the underlying Postgres table itself was intentionally left alone, not migrated away, in case it's ever revisited).

**DB access**: [src/db/index.ts](src/db/index.ts) exports a single `db` (Drizzle), `pool` (pg.Pool, memoized on `globalThis` outside production to survive Next.js hot-reload without exhausting connections), and `withDbRetry()` (one retry with backoff for transient connection failures — use it when wrapping new DB-touching route handlers). Both API routes and `auth.ts` import `db` directly — no repository/service layer.

**Path alias**: `@/*` → `src/*`.
