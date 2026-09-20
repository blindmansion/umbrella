import { describe, expect, test } from "bun:test";
import { newDb } from "pg-mem";
import { queueDepth, runExclusive } from "../src/sandbox/queue";
import {
  createStore,
  type DatabasePool,
  type SessionRecord,
  type TaskRecord,
} from "../src/store";

async function createTestStore() {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memory.adapters.createPg();
  return createStore({
    pool: new adapter.Pool() as unknown as DatabasePool,
  });
}

function task(
  channelId: string,
  overrides: Partial<TaskRecord> = {},
): TaskRecord {
  return {
    channelId,
    kind: "feature",
    repo: "owner/repository",
    refNumber: 42,
    branch: `feature/${channelId}`,
    sandboxId: null,
    status: "provisioning",
    configHash: null,
    statusMessageId: null,
    model: null,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function session(
  threadId: string,
  channelId: string,
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    threadId,
    channelId,
    openCodeSessionId: null,
    model: null,
    createdBy: "user-1",
    createdAt: 1_700_000_000_001,
    ...overrides,
  };
}

describe("state store", () => {
  test("creates, reads, updates, lists, and deletes tasks", async () => {
    const store = await createTestStore();
    const first = task("channel-1");
    const archived = task("channel-2", {
      kind: "planning",
      refNumber: null,
      status: "archived",
    });

    await store.createTask(first);
    await store.createTask(archived);
    expect(await store.getTask(first.channelId)).toEqual(first);

    const updated = await store.updateTask(first.channelId, {
      status: "ready",
      sandboxId: "sandbox-1",
      configHash: "hash-1",
      statusMessageId: "message-1",
    });
    expect(updated).toEqual({
      ...first,
      status: "ready",
      sandboxId: "sandbox-1",
      configHash: "hash-1",
      statusMessageId: "message-1",
    });
    expect(await store.listActiveTasks()).toEqual([updated!]);

    await store.deleteTask(first.channelId);
    expect(await store.getTask(first.channelId)).toBeUndefined();
    await store.close();
  });

  test("creates, reads, updates, and clears sessions", async () => {
    const store = await createTestStore();
    const parent = task("channel-1");
    const first = session("thread-1", parent.channelId);
    const second = session("thread-2", parent.channelId, {
      createdBy: null,
      createdAt: first.createdAt + 1,
    });

    await store.createTask(parent);
    await store.createSession(first);
    await store.createSession(second);
    expect(await store.getSession(first.threadId)).toEqual(first);

    expect(
      await store.updateSessionOpenCodeId(
        first.threadId,
        "opencode-session-1",
      ),
    ).toEqual({
      ...first,
      openCodeSessionId: "opencode-session-1",
    });
    expect(
      await store.updateSessionModel(first.threadId, "anthropic/claude-sonnet-4-6"),
    ).toEqual({
      ...first,
      openCodeSessionId: "opencode-session-1",
      model: "anthropic/claude-sonnet-4-6",
    });
    expect(await store.listSessionsForChannel(parent.channelId)).toEqual([
      {
        ...first,
        openCodeSessionId: "opencode-session-1",
        model: "anthropic/claude-sonnet-4-6",
      },
      second,
    ]);

    await store.clearSessionsForChannel(parent.channelId);
    expect(await store.listSessionsForChannel(parent.channelId)).toEqual([]);
    await store.close();
  });

  test("deleting a task cascades to its sessions", async () => {
    const store = await createTestStore();
    const parent = task("channel-1");
    const child = session("thread-1", parent.channelId);

    await store.createTask(parent);
    await store.createSession(child);
    await store.deleteTask(parent.channelId);

    expect(await store.getSession(child.threadId)).toBeUndefined();
    await store.close();
  });

  test("stores, replaces, and clears a guild's task repository", async () => {
    const store = await createTestStore();

    expect(await store.getGuildRepo("guild-1")).toBeUndefined();

    const created = await store.setGuildRepo("guild-1", "owner/one");
    expect(created.guildId).toBe("guild-1");
    expect(created.repo).toBe("owner/one");
    expect(await store.getGuildRepo("guild-1")).toMatchObject({
      repo: "owner/one",
    });

    const replaced = await store.setGuildRepo("guild-1", "owner/two");
    expect(replaced.repo).toBe("owner/two");
    expect(replaced.createdAt).toBe(created.createdAt);

    await store.clearGuildRepo("guild-1");
    expect(await store.getGuildRepo("guild-1")).toBeUndefined();
    await store.close();
  });
});

describe("per-channel queue", () => {
  test("runs work for one channel in FIFO order and reports depth", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });

    const first = runExclusive("fifo-channel", async () => {
      events.push("first:start");
      markFirstStarted();
      await firstGate;
      events.push("first:end");
      return 1;
    });
    const second = runExclusive("fifo-channel", async () => {
      events.push("second:start");
      events.push("second:end");
      return 2;
    });

    await firstStarted;
    expect(queueDepth("fifo-channel")).toBe(2);
    expect(events).toEqual(["first:start"]);

    releaseFirst();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
    expect(queueDepth("fifo-channel")).toBe(0);
  });

  test("allows different channels to run concurrently", async () => {
    const events: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const channelA = runExclusive("parallel-a", async () => {
      events.push("a:start");
      await gateA;
      events.push("a:end");
    });
    const channelB = runExclusive("parallel-b", async () => {
      events.push("b:start");
      events.push("b:end");
    });

    await channelB;
    expect(events).toEqual(["a:start", "b:start", "b:end"]);
    expect(queueDepth("parallel-a")).toBe(1);
    expect(queueDepth("parallel-b")).toBe(0);

    releaseA();
    await channelA;
    expect(events).toEqual(["a:start", "b:start", "b:end", "a:end"]);
  });
});
