import { describe, expect, test } from "bun:test";
import { createMemoryStore } from "../src/adapters/local/store";
import { createUmbrella } from "../src/core/umbrella";
import type {
  ChatPlatform,
  ExecHandle,
  IncomingMessage,
  MessageRef,
  SandboxHandle,
} from "../src/core/ports";

function fakeChat() {
  let sequence = 0;
  const sent: { channelId: string; text: string }[] = [];
  const chat: ChatPlatform = {
    async reply(to, text) {
      return this.send(to.threadId ?? to.channelId, text);
    },
    async send(channelId, text) {
      sent.push({ channelId, text });
      return { id: `message-${++sequence}`, channelId };
    },
    async edit(ref, text) {
      sent.push({ channelId: ref.channelId, text });
    },
    async pin(_ref) {},
    async startThread() {
      return `thread-${++sequence}`;
    },
    async createTaskChannel() {
      return `task-${++sequence}`;
    },
    async archiveThreads() {},
    async recentTurns() {
      return [];
    },
  };
  return { chat, sent };
}

function sandbox(): SandboxHandle {
  return {
    id: "sandbox-1",
    exec() {
      return Promise.resolve({
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
      }) as ExecHandle;
    },
    async mkdir() {},
    async writeFile() {},
    async destroy() {},
  };
}

const message: IncomingMessage = {
  id: "message-1",
  guildId: "guild-1",
  guildName: "Guild",
  channelId: "general",
  authorId: "user-1",
  authorName: "user",
  text: "please fix https://github.com/owner/repo/issues/42",
  botMentioned: true,
};

describe("createUmbrella", () => {
  test("creates a task from an issue in an untracked channel", async () => {
    const store = createMemoryStore(() => 123);
    const { chat, sent } = fakeChat();
    const runtime = createUmbrella({
      store,
      chat,
      sandboxes: {
        async create() {
          return sandbox();
        },
        async connect() {
          return sandbox();
        },
      },
      github: {
        async fetchMetadata() {
          return { title: "Fix the bug", defaultBranch: "main" };
        },
        async fetchDefaultBranch() {
          return "main";
        },
        async fetchOpenIssues() {
          return [];
        },
      },
      config: {
        model: "test/model",
        sandboxEnv: {},
        configHash: "hash",
      },
      clock: () => 123,
    });

    await runtime.onMessage(message);

    const tasks = await store.listActiveTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      repo: "owner/repo",
      refNumber: 42,
      kind: "feature",
      branch: "feat/42-fix-the-bug",
      status: "ready",
      sandboxId: "sandbox-1",
    });
    expect(sent.some(({ text }) => text.includes("Task ready"))).toBe(true);
  });

  test("keeps instance state and stores isolated", async () => {
    const firstStore = createMemoryStore();
    const secondStore = createMemoryStore();
    const firstChat = fakeChat().chat;
    const secondChat = fakeChat().chat;
    const common = {
      sandboxes: {
        async create() {
          return sandbox();
        },
        async connect() {
          return sandbox();
        },
      },
      github: {
        async fetchMetadata() {
          return {};
        },
        async fetchDefaultBranch() {
          return "main";
        },
        async fetchOpenIssues() {
          return [];
        },
      },
      config: { model: "test/model", sandboxEnv: {}, configHash: "hash" },
    };
    const first = createUmbrella({ ...common, store: firstStore, chat: firstChat });
    createUmbrella({ ...common, store: secondStore, chat: secondChat });

    await first.onCommand({
      type: "repo",
      guildId: "guild",
      action: "set",
      repo: "owner/repo",
    });

    expect((await firstStore.getGuildRepo("guild"))?.repo).toBe("owner/repo");
    expect(await secondStore.getGuildRepo("guild")).toBeUndefined();
  });
});
