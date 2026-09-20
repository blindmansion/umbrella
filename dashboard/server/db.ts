import { Pool, type PoolClient } from "pg";

import { env } from "./env";

export const pool = new Pool({ connectionString: env.databaseUrl });

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT PRIMARY KEY,
    user_name TEXT NULL,
    git_author_name TEXT NULL,
    git_author_email TEXT NULL,
    token_hint TEXT NULL,
    has_token BOOLEAN NOT NULL DEFAULT false,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_secrets (
    user_id TEXT PRIMARY KEY REFERENCES user_settings(user_id) ON DELETE CASCADE,
    encrypted_token TEXT NOT NULL,
    updated_at BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS magic_links (
    nonce TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    guild_name TEXT NULL,
    user_id TEXT NOT NULL,
    user_name TEXT NULL,
    is_admin BOOLEAN NOT NULL,
    expires_at BIGINT NOT NULL,
    consumed_at BIGINT NULL,
    created_at BIGINT NOT NULL
  );
`;

/**
 * The bot owns schema creation, but the dashboard may boot first. This is
 * idempotent and matches `src/adapters/postgres/store.ts`.
 */
export async function ensureSchema(): Promise<void> {
  await pool.query(SCHEMA);
  // Electric needs full old-row data to emit updates and deletes.
  await pool
    .query("ALTER TABLE user_settings REPLICA IDENTITY FULL;")
    .catch(() => undefined);
}

/**
 * Guarantees every signed-in user has a row to update. This keeps the client
 * free of a separate insert-vs-update path: there is always something for
 * TanStack DB to mutate.
 */
export async function ensureUserRow(
  userId: string,
  userName: string | null,
): Promise<void> {
  const now = Date.now();
  await pool.query(
    `INSERT INTO user_settings (user_id, user_name, created_at, updated_at)
     VALUES ($1, $2, $3, $3)
     ON CONFLICT (user_id) DO UPDATE SET
       user_name = COALESCE(EXCLUDED.user_name, user_settings.user_name)`,
    [userId, userName, now],
  );
}

/** Runs `fn` in a transaction and returns PostgreSQL's transaction id. */
export async function withTxid<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<{ result: T; txid: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Must be read inside the same transaction that performs the write, so the
    // txid matches the one Electric emits on the replication stream.
    const { rows } = await client.query<{ txid: string }>(
      "SELECT pg_current_xact_id()::xid::text AS txid",
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return { result, txid: Number(rows[0]!.txid) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
