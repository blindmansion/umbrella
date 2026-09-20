import type {
  GuildRepoRecord,
  SessionRecord,
  StateStore,
  TaskRecord,
} from "../../core/ports";

export function createMemoryStore(clock: () => number = Date.now): StateStore {
  const tasks = new Map<string, TaskRecord>();
  const sessions = new Map<string, SessionRecord>();
  const guilds = new Map<string, GuildRepoRecord>();
  return {
    async close() {},
    async createTask(task) {
      if (tasks.has(task.channelId)) throw new Error("Task already exists");
      tasks.set(task.channelId, { ...task });
    },
    async getTask(id) {
      const value = tasks.get(id);
      return value ? { ...value } : undefined;
    },
    async updateTask(id, update) {
      const value = tasks.get(id);
      if (!value) return undefined;
      const next = { ...value, ...update };
      tasks.set(id, next);
      return { ...next };
    },
    async listActiveTasks() {
      return [...tasks.values()]
        .filter((task) => task.status !== "archived")
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((task) => ({ ...task }));
    },
    async deleteTask(id) {
      tasks.delete(id);
      for (const [threadId, session] of sessions) {
        if (session.channelId === id) sessions.delete(threadId);
      }
    },
    async createSession(session) {
      if (sessions.has(session.threadId)) {
        throw new Error("Session already exists");
      }
      sessions.set(session.threadId, { ...session });
    },
    async getSession(id) {
      const value = sessions.get(id);
      return value ? { ...value } : undefined;
    },
    async updateSessionOpenCodeId(id, openCodeSessionId) {
      const value = sessions.get(id);
      if (!value) return undefined;
      const next = { ...value, openCodeSessionId };
      sessions.set(id, next);
      return { ...next };
    },
    async updateSessionModel(id, model) {
      const value = sessions.get(id);
      if (!value) return undefined;
      const next = { ...value, model };
      sessions.set(id, next);
      return { ...next };
    },
    async updateSessionWorktree(id, workspace) {
      const value = sessions.get(id);
      if (!value) return undefined;
      const next = {
        ...value,
        worktreePath: workspace.path,
        branch: workspace.branch,
      };
      sessions.set(id, next);
      return { ...next };
    },
    async listSessionsForChannel(channelId) {
      return [...sessions.values()]
        .filter((session) => session.channelId === channelId)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((session) => ({ ...session }));
    },
    async clearSessionsForChannel(channelId) {
      for (const [threadId, session] of sessions) {
        if (session.channelId === channelId) sessions.delete(threadId);
      }
    },
    async clearSessionOpenCodeIdsForChannel(channelId) {
      for (const [threadId, session] of sessions) {
        if (session.channelId === channelId) {
          sessions.set(threadId, { ...session, openCodeSessionId: null });
        }
      }
    },
    async setGuildRepo(guildId, repo) {
      const record = {
        guildId,
        repo,
        createdAt: guilds.get(guildId)?.createdAt ?? clock(),
      };
      guilds.set(guildId, record);
      return { ...record };
    },
    async getGuildRepo(guildId) {
      const value = guilds.get(guildId);
      return value ? { ...value } : undefined;
    },
    async clearGuildRepo(guildId) {
      guilds.delete(guildId);
    },
  };
}
