import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
  createdAt: number;
};

export type SessionRecord = {
  threadId: string;
  channelId: string;
  openCodeSessionId: string | null;
  createdBy: string | null;
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
  >
>;

export type StateStore = {
  close(): void;
  createTask(task: TaskRecord): void;
  getTask(channelId: string): TaskRecord | undefined;
  updateTask(channelId: string, update: TaskUpdate): TaskRecord | undefined;
  listActiveTasks(): TaskRecord[];
  deleteTask(channelId: string): void;
  createSession(session: SessionRecord): void;
  getSession(threadId: string): SessionRecord | undefined;
  updateSessionOpenCodeId(
    threadId: string,
    openCodeSessionId: string | null,
  ): SessionRecord | undefined;
  listSessionsForChannel(channelId: string): SessionRecord[];
  clearSessionsForChannel(channelId: string): void;
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
  created_at: number;
};

type SessionRow = {
  thread_id: string;
  channel_id: string;
  opencode_session_id: string | null;
  created_by: string | null;
  created_at: number;
};

const defaultDatabasePath = "data/state.sqlite";

export function createStore(path = defaultDatabasePath): StateStore {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const database = new Database(path, { create: true });
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec(`
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
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      thread_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES tasks(channel_id) ON DELETE CASCADE,
      opencode_session_id TEXT NULL,
      created_by TEXT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  const insertTask = database.prepare(`
    INSERT INTO tasks (
      channel_id, kind, repo, ref_number, branch, sandbox_id, status,
      config_hash, status_message_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectTask = database.prepare(
    "SELECT * FROM tasks WHERE channel_id = ?",
  );
  const selectActiveTasks = database.prepare(
    "SELECT * FROM tasks WHERE status != 'archived' ORDER BY created_at",
  );
  const removeTask = database.prepare("DELETE FROM tasks WHERE channel_id = ?");
  const insertSession = database.prepare(`
    INSERT INTO sessions (
      thread_id, channel_id, opencode_session_id, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const selectSession = database.prepare(
    "SELECT * FROM sessions WHERE thread_id = ?",
  );
  const selectChannelSessions = database.prepare(
    "SELECT * FROM sessions WHERE channel_id = ? ORDER BY created_at",
  );
  const removeChannelSessions = database.prepare(
    "DELETE FROM sessions WHERE channel_id = ?",
  );

  return {
    close() {
      database.close();
    },

    createTask(task) {
      insertTask.run(
        task.channelId,
        task.kind,
        task.repo,
        task.refNumber,
        task.branch,
        task.sandboxId,
        task.status,
        task.configHash,
        task.statusMessageId,
        task.createdAt,
      );
    },

    getTask(channelId) {
      const row = selectTask.get(channelId) as TaskRow | null;
      return row ? taskFromRow(row) : undefined;
    },

    updateTask(channelId, update) {
      const columns: Record<keyof TaskUpdate, string> = {
        kind: "kind",
        repo: "repo",
        refNumber: "ref_number",
        branch: "branch",
        sandboxId: "sandbox_id",
        status: "status",
        configHash: "config_hash",
        statusMessageId: "status_message_id",
      };
      const entries = Object.entries(update).filter(
        (entry): entry is [keyof TaskUpdate, string | number | null] =>
          entry[1] !== undefined,
      );
      if (entries.length > 0) {
        const assignments = entries
          .map(([key]) => `${columns[key]} = ?`)
          .join(", ");
        database
          .prepare(`UPDATE tasks SET ${assignments} WHERE channel_id = ?`)
          .run(...entries.map(([, value]) => value), channelId);
      }
      const row = selectTask.get(channelId) as TaskRow | null;
      return row ? taskFromRow(row) : undefined;
    },

    listActiveTasks() {
      return (selectActiveTasks.all() as TaskRow[]).map(taskFromRow);
    },

    deleteTask(channelId) {
      removeTask.run(channelId);
    },

    createSession(session) {
      insertSession.run(
        session.threadId,
        session.channelId,
        session.openCodeSessionId,
        session.createdBy,
        session.createdAt,
      );
    },

    getSession(threadId) {
      const row = selectSession.get(threadId) as SessionRow | null;
      return row ? sessionFromRow(row) : undefined;
    },

    updateSessionOpenCodeId(threadId, openCodeSessionId) {
      database
        .prepare(
          "UPDATE sessions SET opencode_session_id = ? WHERE thread_id = ?",
        )
        .run(openCodeSessionId, threadId);
      const row = selectSession.get(threadId) as SessionRow | null;
      return row ? sessionFromRow(row) : undefined;
    },

    listSessionsForChannel(channelId) {
      return (selectChannelSessions.all(channelId) as SessionRow[]).map(
        sessionFromRow,
      );
    },

    clearSessionsForChannel(channelId) {
      removeChannelSessions.run(channelId);
    },
  };
}

let defaultStore: StateStore | undefined;

function getDefaultStore(): StateStore {
  defaultStore ??= createStore();
  return defaultStore;
}

export function createTask(task: TaskRecord): void {
  getDefaultStore().createTask(task);
}

export function getTask(channelId: string): TaskRecord | undefined {
  return getDefaultStore().getTask(channelId);
}

export function updateTask(
  channelId: string,
  update: TaskUpdate,
): TaskRecord | undefined {
  return getDefaultStore().updateTask(channelId, update);
}

export function listActiveTasks(): TaskRecord[] {
  return getDefaultStore().listActiveTasks();
}

export function deleteTask(channelId: string): void {
  getDefaultStore().deleteTask(channelId);
}

export function createSession(session: SessionRecord): void {
  getDefaultStore().createSession(session);
}

export function getSession(threadId: string): SessionRecord | undefined {
  return getDefaultStore().getSession(threadId);
}

export function updateSessionOpenCodeId(
  threadId: string,
  openCodeSessionId: string | null,
): SessionRecord | undefined {
  return getDefaultStore().updateSessionOpenCodeId(
    threadId,
    openCodeSessionId,
  );
}

export function listSessionsForChannel(channelId: string): SessionRecord[] {
  return getDefaultStore().listSessionsForChannel(channelId);
}

export function clearSessionsForChannel(channelId: string): void {
  getDefaultStore().clearSessionsForChannel(channelId);
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
    createdAt: row.created_at,
  };
}

function sessionFromRow(row: SessionRow): SessionRecord {
  return {
    threadId: row.thread_id,
    channelId: row.channel_id,
    openCodeSessionId: row.opencode_session_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}
