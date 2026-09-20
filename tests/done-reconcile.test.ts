import { describe, expect, test } from "bun:test";
import { createMemoryStore } from "../src/adapters/local/store";
import { createUmbrella } from "../src/core/umbrella";
import type {
  ChatPlatform,
  ExecHandle,
  IntentClassifier,
  SandboxHandle,
  TaskRecord,
} from "../src/core/ports";

function fakeChat() {
  let sequence = 0;
  const sent: { channelId: string; text: string }[] = [];
  const archivedThreads: string[] = [];
  const archivedChannels: string[] = [];
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
    async pin() {},
    async startThread() {
      return `thread-${++sequence}`;
    },
    async createTaskChannel() {
      return `task-${++sequence}`;
    },
    async archiveThreads(channelId) {
      archivedThreads.push(channelId);
    },
    async archiveChannel(channelId) {
      archivedChannels.push(channelId);
    },
    async recentTurns() {
      return [];
    },
    async transcript() {
      return [];
    },
  };
  return { chat, sent, archivedThreads, archivedChannels };
}

function fakeSandboxes() {
  const destroyed: string[] = [];
  const sandbox = (id: string): SandboxHandle => ({
    id,
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
    async destroy() {
      destroyed.push(id);
    },
  });
  return {
    destroyed,
    provider: {
      async create() {
        return sandbox("sandbox-1");
      },
      async connect(id: string) {
        return sandbox(id);
      },
      async restore() {
        return sandbox("restored-1");
      },
      async listCheckpoints() {
        return [];
      },
      async deleteCheckpoint() {},
    },
  };
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    channelId: "task-1",
    kind: "feature",
    repo: "owner/repo",
    refNumber: 1,
    branch: "feat/1-thing",
    sandboxId: "sandbox-1",
    status: "ready",
    configHash: null,
    statusMessageId: null,
    model: null,
    context: null,
    createdBy: null,
    createdAt: 1,
    ...overrides,
  };
}

function openGithub() {
  return {
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
  };
}

describe("done command", () => {
  test("marks the task archived, destroys the sandbox, and archives the channel", async () => {
    const store = createMemoryStore(() => 1);
    const { chat, sent, archivedChannels, archivedThreads } = fakeChat();
    const { provider, destroyed } = fakeSandboxes();
    const runtime = createUmbrella({
      store,
      chat,
      sandboxes: provider,
      github: openGithub(),
      config: { model: "test/model", sandboxEnv: {}, configHash: "hash" },
      clock: () => 1,
    });
    await store.createTask(task({ statusMessageId: "status-1" }));

    const result = await runtime.onCommand({ type: "done", channelId: "task-1" });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("complete");
    expect(await store.getTask("task-1")).toMatchObject({
      status: "archived",
      sandboxId: null,
    });
    expect(destroyed).toEqual(["sandbox-1"]);
    expect(archivedChannels).toEqual(["task-1"]);
    expect(archivedThreads).toEqual([]);
    expect(await store.listActiveTasks()).toHaveLength(0);
    expect(sent.some(({ text }) => text.includes("archived"))).toBe(true);
  });

  test("is unknown-safe when the channel has no task", async () => {
    const store = createMemoryStore();
    const { chat } = fakeChat();
    const runtime = createUmbrella({
      store,
      chat,
      sandboxes: fakeSandboxes().provider,
      github: openGithub(),
      config: { model: "test/model", sandboxEnv: {}, configHash: "hash" },
    });

    const result = await runtime.onCommand({ type: "done", channelId: "missing" });

    expect(result.ok).toBe(false);
  });

  test("completes the parent task when done is said in a thread", async () => {
    const store = createMemoryStore(() => 1);
    const { chat, archivedChannels } = fakeChat();
    const { provider } = fakeSandboxes();
    const classifier: IntentClassifier = {
      async classify() {
        return { directedAtBot: 1, action: "done", confidence: 0.99 };
      },
    };
    const runtime = createUmbrella({
      store,
      chat,
      sandboxes: provider,
      classifier,
      github: openGithub(),
      config: { model: "test/model", sandboxEnv: {}, configHash: "hash" },
      clock: () => 1,
    });
    await store.createTask(task({ channelId: "task-1" }));
    await store.createSession({
      threadId: "thread-1",
      channelId: "task-1",
      openCodeSessionId: "oc-1",
      model: null,
      worktreePath: null,
      branch: null,
      createdBy: "user-1",
      createdAt: 1,
    });

    await runtime.onMessage({
      id: "m-1",
      guildId: "guild",
      guildName: "Guild",
      channelId: "task-1",
      threadId: "thread-1",
      authorId: "user-1",
      authorName: "user",
      text: "we're done here",
      botMentioned: false,
    });

    expect(await store.getTask("task-1")).toMatchObject({ status: "archived" });
    expect(archivedChannels).toEqual(["task-1"]);
  });
});

describe("reconcileClosedReferences", () => {
  test("completes tasks whose linked reference closed and leaves open ones", async () => {
    const store = createMemoryStore(() => 1);
    const { chat, archivedChannels } = fakeChat();
    const { provider, destroyed } = fakeSandboxes();
    const checked: number[] = [];
    const runtime = createUmbrella({
      store,
      chat,
      sandboxes: provider,
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
        async fetchReferenceState(reference) {
          checked.push(reference.number);
          return reference.number === 1
            ? { state: "closed", merged: false }
            : { state: "open", merged: false };
        },
      },
      config: { model: "test/model", sandboxEnv: {}, configHash: "hash" },
      clock: () => 1,
    });
    await store.createTask(task({ channelId: "task-1", refNumber: 1 }));
    await store.createTask(
      task({ channelId: "task-2", refNumber: 2, sandboxId: "sandbox-2" }),
    );
    await store.createTask(
      task({ channelId: "task-3", refNumber: null, kind: "planning" }),
    );

    const result = await runtime.runMaintenance();

    expect(result.checked).toBe(2);
    expect(result.completed).toEqual(["task-1"]);
    expect(checked).toEqual([1, 2]);
    expect(await store.getTask("task-1")).toMatchObject({ status: "archived" });
    expect(await store.getTask("task-2")).toMatchObject({ status: "ready" });
    expect(await store.getTask("task-3")).toMatchObject({ status: "ready" });
    expect(destroyed).toEqual(["sandbox-1"]);
    expect(archivedChannels).toEqual(["task-1"]);
  });

  test("leaves a task alone when the reference state is unknown", async () => {
    const store = createMemoryStore(() => 1);
    const { chat } = fakeChat();
    const runtime = createUmbrella({
      store,
      chat,
      sandboxes: fakeSandboxes().provider,
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
          return undefined;
        },
      },
      config: { model: "test/model", sandboxEnv: {}, configHash: "hash" },
      clock: () => 1,
    });
    await store.createTask(task({ channelId: "task-1" }));

    const result = await runtime.runMaintenance();

    expect(result.completed).toEqual([]);
    expect(await store.getTask("task-1")).toMatchObject({ status: "ready" });
  });
});
