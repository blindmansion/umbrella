import type {
  GuildRepoRecord,
  MagicLinkRecord,
  SessionRecord,
  StateStore,
  TaskRecord,
  UserSecretRecord,
  UserSettingsRecord,
} from "../../core/ports";

export function createMemoryStore(clock: () => number = Date.now): StateStore {
  const tasks = new Map<string, TaskRecord>();
  const sessions = new Map<string, SessionRecord>();
  const guilds = new Map<string, GuildRepoRecord>();
  const userSettings = new Map<string, UserSettingsRecord>();
  const userSecrets = new Map<string, UserSecretRecord>();
  const magicLinks = new Map<string, MagicLinkRecord>();
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
    async getUserSettings(userId) {
      const value = userSettings.get(userId);
      return value ? { ...value } : undefined;
    },
    async listUserSettings() {
      return [...userSettings.values()]
        .sort((a, b) => a.userId.localeCompare(b.userId))
        .map((value) => ({ ...value }));
    },
    async upsertUserSettings(userId, update) {
      const existing = userSettings.get(userId);
      const next: UserSettingsRecord = {
        userId,
        userName:
          update.userName !== undefined
            ? update.userName
            : existing?.userName ?? null,
        gitAuthorName:
          update.gitAuthorName !== undefined
            ? update.gitAuthorName
            : existing?.gitAuthorName ?? null,
        gitAuthorEmail:
          update.gitAuthorEmail !== undefined
            ? update.gitAuthorEmail
            : existing?.gitAuthorEmail ?? null,
        tokenHint:
          update.tokenHint !== undefined
            ? update.tokenHint
            : existing?.tokenHint ?? null,
        hasToken:
          update.encryptedToken !== undefined
            ? update.encryptedToken !== null
            : existing?.hasToken ?? false,
        createdAt: existing?.createdAt ?? update.updatedAt,
        updatedAt: update.updatedAt,
      };
      userSettings.set(userId, next);
      if (update.encryptedToken !== undefined) {
        if (update.encryptedToken === null) {
          userSecrets.delete(userId);
        } else {
          userSecrets.set(userId, {
            userId,
            encryptedToken: update.encryptedToken,
            updatedAt: update.updatedAt,
          });
        }
      }
      return { ...next };
    },
    async getUserSecret(userId) {
      const value = userSecrets.get(userId);
      return value ? { ...value } : undefined;
    },
    async createMagicLink(link) {
      magicLinks.set(link.nonce, { ...link });
    },
    async consumeMagicLink(nonce, now) {
      const value = magicLinks.get(nonce);
      if (!value || value.consumedAt !== null || value.expiresAt <= now) {
        return undefined;
      }
      const consumed = { ...value, consumedAt: now };
      magicLinks.set(nonce, consumed);
      return { ...consumed };
    },
    async deleteExpiredMagicLinks(now) {
      for (const [nonce, link] of magicLinks) {
        if (link.expiresAt <= now || link.consumedAt !== null) {
          magicLinks.delete(nonce);
        }
      }
    },
  };
}
