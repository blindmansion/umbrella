import { Pool, type QueryResult, type QueryResultRow } from "pg";

export type TaskKind = "planning" | "feature" | "bugfix" | "review";
export type TaskStatus = "provisioning" | "ready" | "archived";

export type TaskRecord = {
  channelId: string;
  kind: TaskKind;
  repo: string;
  refNumber: number | null;
  branch: string;
  sandboxId: string | null;
  status: TaskStatus;
  configHash: string | null;
  statusMessageId: string | null;
  model: string | null;
  context: string | null;
  createdAt: number;
};

export type SessionRecord = {
  threadId: string;
  channelId: string;
  openCodeSessionId: string | null;
  model: string | null;
  createdBy: string | null;
  createdAt: number;
};

export type GuildRepoRecord = {
  guildId: string;
  repo: string;
  createdAt: number;
};

export type TaskUpdate = Partial<
  Pick<
    TaskRecord,
    | "kind"
    | "repo"
    | "refNumber"
    | "branch"
    | "sandboxId"
    | "status"
    | "configHash"
    | "statusMessageId"
    | "model"
    | "context"
  >
>;

export type StateStore = {
  close(): Promise<void>;
  createTask(task: TaskRecord): Promise<void>;
  getTask(channelId: string): Promise<TaskRecord | undefined>;
  updateTask(
    channelId: string,
    update: TaskUpdate,
  ): Promise<TaskRecord | undefined>;
  listActiveTasks(): Promise<TaskRecord[]>;
  deleteTask(channelId: string): Promise<void>;
  createSession(session: SessionRecord): Promise<void>;
  getSession(threadId: string): Promise<SessionRecord | undefined>;
  updateSessionOpenCodeId(
    threadId: string,
    openCodeSessionId: string | null,
  ): Promise<SessionRecord | undefined>;
  updateSessionModel(
    threadId: string,
    model: string | null,
  ): Promise<SessionRecord | undefined>;
  listSessionsForChannel(channelId: string): Promise<SessionRecord[]>;
  clearSessionsForChannel(channelId: string): Promise<void>;
  setGuildRepo(guildId: string, repo: string): Promise<GuildRepoRecord>;
  getGuildRepo(guildId: string): Promise<GuildRepoRecord | undefined>;
  clearGuildRepo(guildId: string): Promise<void>;
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
  created_at: number;
};

type SessionRow = {
  thread_id: string;
  channel_id: string;
  opencode_session_id: string | null;
  model: string | null;
  created_by: string | null;
  created_at: number;
};

type GuildRepoRow = {
  guild_id: string;
  repo: string;
  created_at: number;
};

export type DatabasePool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
  end(): Promise<void>;
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
      created_by TEXT NULL,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS guilds (
      guild_id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );

    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS model TEXT NULL;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS context TEXT NULL;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS model TEXT NULL;
  `);

  return {
    async close() {
      await database.end();
    },

    async createTask(task) {
      await database.query(
        `INSERT INTO tasks (
          channel_id, kind, repo, ref_number, branch, sandbox_id, status,
          config_hash, status_message_id, model, context, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
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
          task.createdAt,
        ],
      );
    },

    async getTask(channelId) {
      const { rows } = await database.query<TaskRow>(
        "SELECT * FROM tasks WHERE channel_id = $1",
        [channelId],
      );
      const row = rows[0];
      return row ? taskFromRow(row) : undefined;
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
      const row = rows[0];
      return row ? taskFromRow(row) : undefined;
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
          thread_id, channel_id, opencode_session_id, model, created_by, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          session.threadId,
          session.channelId,
          session.openCodeSessionId,
          session.model,
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
      const row = rows[0];
      return row ? sessionFromRow(row) : undefined;
    },

    async updateSessionOpenCodeId(threadId, openCodeSessionId) {
      const { rows } = await database.query<SessionRow>(
        `UPDATE sessions
         SET opencode_session_id = $1
         WHERE thread_id = $2
         RETURNING *`,
        [openCodeSessionId, threadId],
      );
      const row = rows[0];
      return row ? sessionFromRow(row) : undefined;
    },

    async updateSessionModel(threadId, model) {
      const { rows } = await database.query<SessionRow>(
        `UPDATE sessions
         SET model = $1
         WHERE thread_id = $2
         RETURNING *`,
        [model, threadId],
      );
      const row = rows[0];
      return row ? sessionFromRow(row) : undefined;
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
      const row = rows[0];
      return row ? guildRepoFromRow(row) : undefined;
    },

    async clearGuildRepo(guildId) {
      await database.query("DELETE FROM guilds WHERE guild_id = $1", [guildId]);
    },
  };
}

let defaultStore: Promise<StateStore> | undefined;

function getDefaultStore(): Promise<StateStore> {
  defaultStore ??= createStore();
  return defaultStore;
}

export async function initializeStore(): Promise<void> {
  await getDefaultStore();
}

export async function createTask(task: TaskRecord): Promise<void> {
  return (await getDefaultStore()).createTask(task);
}

export async function getTask(
  channelId: string,
): Promise<TaskRecord | undefined> {
  return (await getDefaultStore()).getTask(channelId);
}

export async function updateTask(
  channelId: string,
  update: TaskUpdate,
): Promise<TaskRecord | undefined> {
  return (await getDefaultStore()).updateTask(channelId, update);
}

export async function listActiveTasks(): Promise<TaskRecord[]> {
  return (await getDefaultStore()).listActiveTasks();
}

export async function deleteTask(channelId: string): Promise<void> {
  return (await getDefaultStore()).deleteTask(channelId);
}

export async function createSession(session: SessionRecord): Promise<void> {
  return (await getDefaultStore()).createSession(session);
}

export async function getSession(
  threadId: string,
): Promise<SessionRecord | undefined> {
  return (await getDefaultStore()).getSession(threadId);
}

export async function updateSessionOpenCodeId(
  threadId: string,
  openCodeSessionId: string | null,
): Promise<SessionRecord | undefined> {
  return (await getDefaultStore()).updateSessionOpenCodeId(
    threadId,
    openCodeSessionId,
  );
}

export async function updateSessionModel(
  threadId: string,
  model: string | null,
): Promise<SessionRecord | undefined> {
  return (await getDefaultStore()).updateSessionModel(threadId, model);
}

export async function listSessionsForChannel(
  channelId: string,
): Promise<SessionRecord[]> {
  return (await getDefaultStore()).listSessionsForChannel(channelId);
}

export async function clearSessionsForChannel(
  channelId: string,
): Promise<void> {
  return (await getDefaultStore()).clearSessionsForChannel(channelId);
}

export async function setGuildRepo(
  guildId: string,
  repo: string,
): Promise<GuildRepoRecord> {
  return (await getDefaultStore()).setGuildRepo(guildId, repo);
}

export async function getGuildRepo(
  guildId: string,
): Promise<GuildRepoRecord | undefined> {
  return (await getDefaultStore()).getGuildRepo(guildId);
}

export async function clearGuildRepo(guildId: string): Promise<void> {
  return (await getDefaultStore()).clearGuildRepo(guildId);
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
    createdAt: Number(row.created_at),
  };
}

function sessionFromRow(row: SessionRow): SessionRecord {
  return {
    threadId: row.thread_id,
    channelId: row.channel_id,
    openCodeSessionId: row.opencode_session_id,
    model: row.model,
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
