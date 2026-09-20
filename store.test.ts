import { describe, expect, test } from "bun:test";
import { queueDepth, runExclusive } from "./sandboxes";
import {
  createStore,
  type SessionRecord,
  type TaskRecord,
} from "./store";

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
    createdBy: "user-1",
    createdAt: 1_700_000_000_001,
    ...overrides,
  };
}

describe("state store", () => {
  test("creates, reads, updates, lists, and deletes tasks", () => {
    const store = createStore(":memory:");
    const first = task("channel-1");
    const archived = task("channel-2", {
      kind: "planning",
      refNumber: null,
      status: "archived",
    });

    store.createTask(first);
    store.createTask(archived);
    expect(store.getTask(first.channelId)).toEqual(first);

    const updated = store.updateTask(first.channelId, {
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
    expect(store.listActiveTasks()).toEqual([updated!]);

    store.deleteTask(first.channelId);
    expect(store.getTask(first.channelId)).toBeUndefined();
    store.close();
  });

  test("creates, reads, updates, and clears sessions", () => {
    const store = createStore(":memory:");
    const parent = task("channel-1");
    const first = session("thread-1", parent.channelId);
    const second = session("thread-2", parent.channelId, {
      createdBy: null,
      createdAt: first.createdAt + 1,
    });

    store.createTask(parent);
    store.createSession(first);
    store.createSession(second);
    expect(store.getSession(first.threadId)).toEqual(first);

    expect(
      store.updateSessionOpenCodeId(first.threadId, "opencode-session-1"),
    ).toEqual({
      ...first,
      openCodeSessionId: "opencode-session-1",
    });
    expect(store.listSessionsForChannel(parent.channelId)).toEqual([
      { ...first, openCodeSessionId: "opencode-session-1" },
      second,
    ]);

    store.clearSessionsForChannel(parent.channelId);
    expect(store.listSessionsForChannel(parent.channelId)).toEqual([]);
    store.close();
  });

  test("deleting a task cascades to its sessions", () => {
    const store = createStore(":memory:");
    const parent = task("channel-1");
    const child = session("thread-1", parent.channelId);

    store.createTask(parent);
    store.createSession(child);
    store.deleteTask(parent.channelId);

    expect(store.getSession(child.threadId)).toBeUndefined();
    store.close();
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
