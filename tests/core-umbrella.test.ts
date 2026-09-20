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
    async archiveChannel() {},
    async recentTurns() {
      return [];
    },
    async transcript() {
      return [];
    },
  };
  return { chat, sent };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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
    async checkpoint() {},
    async destroy() {},
  };
}

function fakeSandboxes() {
  return {
    async create() {
      return sandbox();
    },
    async connect() {
      return sandbox();
    },
    async restore() {
      return sandbox();
    },
    async listCheckpoints() {
      return [];
    },
    async deleteCheckpoint() {},
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
      sandboxes: fakeSandboxes(),
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
        async fetchReferenceState() {
          return { state: "open", merged: false };
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

  test("creates a per-thread worktree and localizes the session cwd", async () => {
    const store = createMemoryStore(() => 123);
    const { chat } = fakeChat();
    const calls: { command: string; cwd?: string }[] = [];
    const executionSandbox: SandboxHandle = {
      id: "sandbox-1",
      exec(command, options) {
        calls.push({ command, cwd: options?.cwd });
        const stdout = command.includes("opencode run")
          ? '{"type":"text","sessionID":"oc-1","part":{"text":"Done."}}\n'
          : "";
        options?.onStdout?.(stdout);
        return Promise.resolve({
          exitCode: 0,
          stdout,
          stderr: "",
          timedOut: false,
        }) as ExecHandle;
      },
      async mkdir() {},
      async writeFile() {},
      async checkpoint() {},
      async destroy() {},
    };
    const runtime = createUmbrella({
      store,
      chat,
      sandboxes: {
        async create() {
          return executionSandbox;
        },
        async connect() {
          return executionSandbox;
        },
        async restore() {
          return executionSandbox;
        },
        async listCheckpoints() {
          return [];
        },
        async deleteCheckpoint() {},
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
        async fetchReferenceState() {
          return { state: "open", merged: false };
        },
      },
      config: { model: "test/model", sandboxEnv: {}, configHash: "hash" },
      clock: () => 123,
    });

    await runtime.onMessage(message);
    const task = (await store.listActiveTasks())[0]!;
    await runtime.onMessage({
      ...message,
      id: "message-2",
      channelId: task.channelId,
      text: "add a test for this",
    });

    const sessions = await store.listSessionsForChannel(task.channelId);
    expect(sessions).toHaveLength(1);
    const session = sessions[0]!;
    expect(session.worktreePath).toBe(`/root/worktrees/${session.threadId}`);
    expect(session.branch).toBe(`feat/42-fix-the-bug-${session.threadId}`);
    expect(
      calls.some(({ command }) => command.includes("git worktree add -b")),
    ).toBe(true);
    expect(
      calls.some(
        ({ command }) =>
          command.includes("opencode run") &&
          command.includes(session.worktreePath!),
      ),
    ).toBe(true);
  });

  test("runs OpenCode for different threads in the same task concurrently", async () => {
    const store = createMemoryStore(() => 123);
    const { chat } = fakeChat();
    let inFlightOpenCode = 0;
    let maxInFlightOpenCode = 0;
    const release: Array<() => void> = [];
    const executionSandbox: SandboxHandle = {
      id: "sandbox-1",
      exec(command, options) {
        if (!command.includes("opencode run")) {
          return Promise.resolve({
            exitCode: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
          }) as ExecHandle;
        }
        inFlightOpenCode += 1;
        maxInFlightOpenCode = Math.max(maxInFlightOpenCode, inFlightOpenCode);
        const stdout =
          '{"type":"text","sessionID":"oc-1","part":{"text":"Done."}}\n';
        options?.onStdout?.(stdout);
        return new Promise((resolve) => {
          release.push(() => {
            inFlightOpenCode -= 1;
            resolve({
              exitCode: 0,
              stdout,
              stderr: "",
              timedOut: false,
            });
          });
        }) as ExecHandle;
      },
      async mkdir() {},
      async writeFile() {},
      async checkpoint() {},
      async destroy() {},
    };
    const runtime = createUmbrella({
      store,
      chat,
      sandboxes: {
        async create() {
          return executionSandbox;
        },
        async connect() {
          return executionSandbox;
        },
        async restore() {
          return executionSandbox;
        },
        async listCheckpoints() {
          return [];
        },
        async deleteCheckpoint() {},
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
        async fetchReferenceState() {
          return { state: "open", merged: false };
        },
      },
      config: { model: "test/model", sandboxEnv: {}, configHash: "hash" },
      clock: () => 123,
    });

    await runtime.onMessage(message);
    const task = (await store.listActiveTasks())[0]!;
    const first = runtime.onMessage({
      ...message,
      id: "message-2",
      channelId: task.channelId,
      text: "first prompt",
    });
    const second = runtime.onMessage({
      ...message,
      id: "message-3",
      channelId: task.channelId,
      text: "second prompt",
    });

    await waitFor(() => maxInFlightOpenCode === 2, "concurrent OpenCode runs");
    expect(await store.listSessionsForChannel(task.channelId)).toHaveLength(2);

    for (const done of release) done();
    await Promise.all([first, second]);
    expect(maxInFlightOpenCode).toBe(2);
    expect(inFlightOpenCode).toBe(0);
  });

  test("rejects a second prompt in a thread that is already running", async () => {
    const store = createMemoryStore(() => 123);
    const { chat, sent } = fakeChat();
    let releaseOpenCode: (() => void) | undefined;
    const executionSandbox: SandboxHandle = {
      id: "sandbox-1",
      exec(command, options) {
        if (!command.includes("opencode run")) {
          return Promise.resolve({
            exitCode: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
          }) as ExecHandle;
        }
        const stdout =
          '{"type":"text","sessionID":"oc-1","part":{"text":"Done."}}\n';
        options?.onStdout?.(stdout);
        return new Promise((resolve) => {
          releaseOpenCode = () =>
            resolve({
              exitCode: 0,
              stdout,
              stderr: "",
              timedOut: false,
            });
        }) as ExecHandle;
      },
      async mkdir() {},
      async writeFile() {},
      async checkpoint() {},
      async destroy() {},
    };
    const runtime = createUmbrella({
      store,
      chat,
      sandboxes: {
        async create() {
          return executionSandbox;
        },
        async connect() {
          return executionSandbox;
        },
        async restore() {
          return executionSandbox;
        },
        async listCheckpoints() {
          return [];
        },
        async deleteCheckpoint() {},
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
        async fetchReferenceState() {
          return { state: "open", merged: false };
        },
      },
      config: { model: "test/model", sandboxEnv: {}, configHash: "hash" },
      clock: () => 123,
    });

    await runtime.onMessage(message);
    const task = (await store.listActiveTasks())[0]!;
    const first = runtime.onMessage({
      ...message,
      id: "message-2",
      channelId: task.channelId,
      text: "first prompt",
    });
    await waitFor(
      () => releaseOpenCode !== undefined,
      "first OpenCode run to start",
    );
    const session = (await store.listSessionsForChannel(task.channelId))[0]!;
    await runtime.onMessage({
      ...message,
      id: "message-3",
      channelId: task.channelId,
      threadId: session.threadId,
      text: "second prompt",
    });
    expect(
      sent.some(({ text }) =>
        text.includes("I'm still working on the previous prompt in this thread."),
      ),
    ).toBe(true);

    releaseOpenCode?.();
    await first;
  });

  test("keeps instance state and stores isolated", async () => {
    const firstStore = createMemoryStore();
    const secondStore = createMemoryStore();
    const firstChat = fakeChat().chat;
    const secondChat = fakeChat().chat;
    const common = {
      sandboxes: fakeSandboxes(),
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
        async fetchReferenceState() {
          return { state: "open" as const, merged: false };
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
