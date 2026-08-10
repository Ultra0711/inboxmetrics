import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1")
      ? false
      : { rejectUnauthorized: false },
    // The Supabase pooler occasionally stalls or drops the handshake under
    // load — 8s was tight enough to surface as a false "no data" state on
    // the dashboard. 15s plus the retry in withDbRetry() below absorbs that.
    connectionTimeoutMillis: 15000,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

export const db = drizzle(pool);

// The Supabase pooler intermittently times out or drops the connection
// handshake (observed directly, not hypothetical) rather than the DB itself
// being down. One retry after a short backoff turns most of those into a
// successful request instead of the API route surfacing a false "no data".
export async function withDbRetry<T>(fn: () => Promise<T>, retries = 1): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (retries <= 0) throw err;
    await new Promise((resolve) => setTimeout(resolve, 500));
    return withDbRetry(fn, retries - 1);
  }
}