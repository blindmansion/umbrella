import { Pool, type QueryResult, type QueryResultRow } from "pg";
import type {
  GuildRepoRecord,
  MagicLinkRecord,
  SessionRecord,
  StateStore,
  TaskKind,
  TaskRecord,
  TaskStatus,
  TaskUpdate,
  UserSecretRecord,
  UserSettingsRecord,
} from "../../core/ports";

export type DatabasePool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
  end(): Promise<void>;
};

type TaskRow = {
  channel_id: string;
  kind: TaskKind;
  repo: string;
  ref_number: number | null;
  branch: string;
  sandbox_id: string | null;
  status: TaskStatus;
  config_hash: string | null;
  status_message_id: string | null;
  model: string | null;
  context: string | null;
  created_by: string | null;
  created_at: number;
};

type UserSettingsRow = {
  user_id: string;
  user_name: string | null;
  git_author_name: string | null;
  git_author_email: string | null;
  token_hint: string | null;
  has_token: boolean;
  created_at: number;
  updated_at: number;
};

type UserSecretRow = {
  user_id: string;
  encrypted_token: string;
  updated_at: number;
};

type MagicLinkRow = {
  nonce: string;
  guild_id: string;
  guild_name: string | null;
  user_id: string;
  user_name: string | null;
  is_admin: boolean;
  expires_at: number;
  consumed_at: number | null;
  created_at: number;
};

type SessionRow = {
  thread_id: string;
  channel_id: string;
  opencode_session_id: string | null;
  model: string | null;
  worktree_path: string | null;
  branch: string | null;
  created_by: string | null;
  created_at: number;
};

type GuildRepoRow = {
  guild_id: string;
  repo: string;
  created_at: number;
};

export async function createStore(options: {
  connectionString?: string;
  pool?: DatabasePool;
} = {}): Promise<StateStore> {
  const connectionString = options.connectionString ?? Bun.env.DATABASE_URL;
  if (!options.pool && !connectionString) {
    throw new Error("DATABASE_URL must be set");
  }

  const database: DatabasePool =
    options.pool ?? new Pool({ connectionString });
  await database.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      channel_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('planning', 'feature', 'bugfix', 'review')),
      repo TEXT NOT NULL,
      ref_number INTEGER NULL,
      branch TEXT NOT NULL,
      sandbox_id TEXT NULL,
      status TEXT NOT NULL CHECK (status IN ('provisioning', 'ready', 'archived')),
      config_hash TEXT NULL,
      status_message_id TEXT NULL,
      model TEXT NULL,
      context TEXT NULL,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      thread_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES tasks(channel_id) ON DELETE CASCADE,
      opencode_session_id TEXT NULL,
      model TEXT NULL,
      worktree_path TEXT NULL,
      branch TEXT NULL,
      created_by TEXT NULL,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS guilds (
      guild_id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );

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

    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS model TEXT NULL;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS context TEXT NULL;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_by TEXT NULL;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS model TEXT NULL;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS worktree_path TEXT NULL;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS branch TEXT NULL;
  `);

  // Electric needs full old-row data for updates/deletes. Not every Postgres
  // (notably pg-mem in tests) supports this statement.
  await database
    .query("ALTER TABLE user_settings REPLICA IDENTITY FULL;")
    .catch(() => undefined);

  return {
    async close() {
      await database.end();
    },

    async createTask(task) {
      await database.query(
        `INSERT INTO tasks (
          channel_id, kind, repo, ref_number, branch, sandbox_id, status,
          config_hash, status_message_id, model, context, created_by, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          task.channelId,
          task.kind,
          task.repo,
          task.refNumber,
          task.branch,
          task.sandboxId,
          task.status,
          task.configHash,
          task.statusMessageId,
          task.model,
          task.context,
          task.createdBy,
          task.createdAt,
        ],
      );
    },

    async getTask(channelId) {
      const { rows } = await database.query<TaskRow>(
        "SELECT * FROM tasks WHERE channel_id = $1",
        [channelId],
      );
      return rows[0] ? taskFromRow(rows[0]) : undefined;
    },

    async updateTask(channelId, update) {
      const columns: Record<keyof TaskUpdate, string> = {
        kind: "kind",
        repo: "repo",
        refNumber: "ref_number",
        branch: "branch",
        sandboxId: "sandbox_id",
        status: "status",
        configHash: "config_hash",
        statusMessageId: "status_message_id",
        model: "model",
        context: "context",
      };
      const entries = Object.entries(update).filter(
        (entry): entry is [keyof TaskUpdate, string | number | null] =>
          entry[1] !== undefined,
      );
      if (entries.length > 0) {
        const assignments = entries
          .map(([key], index) => `${columns[key]} = $${index + 1}`)
          .join(", ");
        await database.query(
          `UPDATE tasks SET ${assignments} WHERE channel_id = $${entries.length + 1}`,
          [...entries.map(([, value]) => value), channelId],
        );
      }
      const { rows } = await database.query<TaskRow>(
        "SELECT * FROM tasks WHERE channel_id = $1",
        [channelId],
      );
      return rows[0] ? taskFromRow(rows[0]) : undefined;
    },

    async listActiveTasks() {
      const { rows } = await database.query<TaskRow>(
        "SELECT * FROM tasks WHERE status != 'archived' ORDER BY created_at",
      );
      return rows.map(taskFromRow);
    },

    async deleteTask(channelId) {
      await database.query("DELETE FROM tasks WHERE channel_id = $1", [channelId]);
    },

    async createSession(session) {
      await database.query(
        `INSERT INTO sessions (
          thread_id, channel_id, opencode_session_id, model, worktree_path,
          branch, created_by, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          session.threadId,
          session.channelId,
          session.openCodeSessionId,
          session.model,
          session.worktreePath,
          session.branch,
          session.createdBy,
          session.createdAt,
        ],
      );
    },

    async getSession(threadId) {
      const { rows } = await database.query<SessionRow>(
        "SELECT * FROM sessions WHERE thread_id = $1",
        [threadId],
      );
      return rows[0] ? sessionFromRow(rows[0]) : undefined;
    },

    async updateSessionOpenCodeId(threadId, openCodeSessionId) {
      const { rows } = await database.query<SessionRow>(
        `UPDATE sessions
         SET opencode_session_id = $1
         WHERE thread_id = $2
         RETURNING *`,
        [openCodeSessionId, threadId],
      );
      return rows[0] ? sessionFromRow(rows[0]) : undefined;
    },

    async updateSessionModel(threadId, model) {
      const { rows } = await database.query<SessionRow>(
        `UPDATE sessions
         SET model = $1
         WHERE thread_id = $2
         RETURNING *`,
        [model, threadId],
      );
      return rows[0] ? sessionFromRow(rows[0]) : undefined;
    },

    async updateSessionWorktree(threadId, workspace) {
      const { rows } = await database.query<SessionRow>(
        `UPDATE sessions
         SET worktree_path = $1, branch = $2
         WHERE thread_id = $3
         RETURNING *`,
        [workspace.path, workspace.branch, threadId],
      );
      return rows[0] ? sessionFromRow(rows[0]) : undefined;
    },

    async listSessionsForChannel(channelId) {
      const { rows } = await database.query<SessionRow>(
        "SELECT * FROM sessions WHERE channel_id = $1 ORDER BY created_at",
        [channelId],
      );
      return rows.map(sessionFromRow);
    },

    async clearSessionsForChannel(channelId) {
      await database.query("DELETE FROM sessions WHERE channel_id = $1", [
        channelId,
      ]);
    },

    async clearSessionOpenCodeIdsForChannel(channelId) {
      await database.query(
        "UPDATE sessions SET opencode_session_id = NULL WHERE channel_id = $1",
        [channelId],
      );
    },

    async setGuildRepo(guildId, repo) {
      const { rows } = await database.query<GuildRepoRow>(
        `INSERT INTO guilds (guild_id, repo, created_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (guild_id)
         DO UPDATE SET repo = EXCLUDED.repo
         RETURNING *`,
        [guildId, repo, Date.now()],
      );
      return guildRepoFromRow(rows[0]!);
    },

    async getGuildRepo(guildId) {
      const { rows } = await database.query<GuildRepoRow>(
        "SELECT * FROM guilds WHERE guild_id = $1",
        [guildId],
      );
      return rows[0] ? guildRepoFromRow(rows[0]) : undefined;
    },

    async clearGuildRepo(guildId) {
      await database.query("DELETE FROM guilds WHERE guild_id = $1", [guildId]);
    },

    async getUserSettings(userId) {
      const { rows } = await database.query<UserSettingsRow>(
        "SELECT * FROM user_settings WHERE user_id = $1",
        [userId],
      );
      return rows[0] ? userSettingsFromRow(rows[0]) : undefined;
    },

    async listUserSettings() {
      const { rows } = await database.query<UserSettingsRow>(
        "SELECT * FROM user_settings ORDER BY user_id",
      );
      return rows.map(userSettingsFromRow);
    },

    async upsertUserSettings(userId, update) {
      const encryptedToken = update.encryptedToken;
      const { rows } = await database.query<UserSettingsRow>(
        `INSERT INTO user_settings (
          user_id, user_name, git_author_name, git_author_email, token_hint,
          has_token, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
        ON CONFLICT (user_id) DO UPDATE SET
          user_name = COALESCE(EXCLUDED.user_name, user_settings.user_name),
          git_author_name = COALESCE(EXCLUDED.git_author_name, user_settings.git_author_name),
          git_author_email = COALESCE(EXCLUDED.git_author_email, user_settings.git_author_email),
          token_hint = COALESCE(EXCLUDED.token_hint, user_settings.token_hint),
          has_token = CASE
            WHEN $8 THEN true
            WHEN $9 THEN false
            ELSE user_settings.has_token
          END,
          updated_at = EXCLUDED.updated_at
        RETURNING *`,
        [
          userId,
          update.userName ?? null,
          update.gitAuthorName ?? null,
          update.gitAuthorEmail ?? null,
          update.tokenHint ?? null,
          encryptedToken !== undefined && encryptedToken !== null,
          update.updatedAt,
          encryptedToken !== undefined && encryptedToken !== null,
          encryptedToken === null,
        ],
      );
      if (encryptedToken !== undefined) {
        if (encryptedToken === null) {
          await database.query("DELETE FROM user_secrets WHERE user_id = $1", [
            userId,
          ]);
        } else {
          await database.query(
            `INSERT INTO user_secrets (user_id, encrypted_token, updated_at)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id) DO UPDATE SET
               encrypted_token = EXCLUDED.encrypted_token,
               updated_at = EXCLUDED.updated_at`,
            [userId, encryptedToken, update.updatedAt],
          );
        }
      }
      return userSettingsFromRow(rows[0]!);
    },

    async getUserSecret(userId) {
      const { rows } = await database.query<UserSecretRow>(
        "SELECT * FROM user_secrets WHERE user_id = $1",
        [userId],
      );
      return rows[0] ? userSecretFromRow(rows[0]) : undefined;
    },

    async createMagicLink(link) {
      await database.query(
        `INSERT INTO magic_links (
          nonce, guild_id, guild_name, user_id, user_name, is_admin,
          expires_at, consumed_at, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8)
        ON CONFLICT (nonce) DO NOTHING`,
        [
          link.nonce,
          link.guildId,
          link.guildName,
          link.userId,
          link.userName,
          link.isAdmin,
          link.expiresAt,
          link.createdAt,
        ],
      );
    },

    async consumeMagicLink(nonce, now) {
      const { rows } = await database.query<MagicLinkRow>(
        `UPDATE magic_links
         SET consumed_at = $2
         WHERE nonce = $1 AND consumed_at IS NULL AND expires_at > $2
         RETURNING *`,
        [nonce, now],
      );
      return rows[0] ? magicLinkFromRow(rows[0]) : undefined;
    },

    async deleteExpiredMagicLinks(now) {
      await database.query(
        "DELETE FROM magic_links WHERE expires_at <= $1 OR consumed_at IS NOT NULL",
        [now],
      );
    },
  };
}

function taskFromRow(row: TaskRow): TaskRecord {
  return {
    channelId: row.channel_id,
    kind: row.kind,
    repo: row.repo,
    refNumber: row.ref_number,
    branch: row.branch,
    sandboxId: row.sandbox_id,
    status: row.status,
    configHash: row.config_hash,
    statusMessageId: row.status_message_id,
    model: row.model,
    context: row.context,
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
  };
}

function userSettingsFromRow(row: UserSettingsRow): UserSettingsRecord {
  return {
    userId: row.user_id,
    userName: row.user_name,
    gitAuthorName: row.git_author_name,
    gitAuthorEmail: row.git_author_email,
    tokenHint: row.token_hint,
    hasToken: row.has_token,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function userSecretFromRow(row: UserSecretRow): UserSecretRecord {
  return {
    userId: row.user_id,
    encryptedToken: row.encrypted_token,
    updatedAt: Number(row.updated_at),
  };
}

function magicLinkFromRow(row: MagicLinkRow): MagicLinkRecord {
  return {
    nonce: row.nonce,
    guildId: row.guild_id,
    guildName: row.guild_name,
    userId: row.user_id,
    userName: row.user_name,
    isAdmin: row.is_admin,
    expiresAt: Number(row.expires_at),
    consumedAt: row.consumed_at === null ? null : Number(row.consumed_at),
    createdAt: Number(row.created_at),
  };
}

function sessionFromRow(row: SessionRow): SessionRecord {
  return {
    threadId: row.thread_id,
    channelId: row.channel_id,
    openCodeSessionId: row.opencode_session_id,
    model: row.model,
    worktreePath: row.worktree_path,
    branch: row.branch,
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
  };
}

function guildRepoFromRow(row: GuildRepoRow): GuildRepoRecord {
  return {
    guildId: row.guild_id,
    repo: row.repo,
    createdAt: Number(row.created_at),
  };
}
