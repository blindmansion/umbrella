import { beforeEach, describe, expect, test } from "bun:test";
import type {
  ExecHandle,
  SandboxCheckpoint,
  SandboxHandle,
  SandboxProvider,
  TaskRecord,
} from "../src/core/ports";
import {
  SandboxManager,
  checkpointNameForChannel,
} from "../src/core/sandboxes";

type FakeSandbox = SandboxHandle & { destroyed: boolean };

function makeSandbox(id: string): FakeSandbox {
  return {
    id,
    destroyed: false,
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
      this.destroyed = true;
    },
  };
}

const createdSources: (string | undefined)[] = [];
let checkpoints: SandboxCheckpoint[] = [];
let connectResult: (id: string) => FakeSandbox | Promise<FakeSandbox>;

function provider(): SandboxProvider {
  return {
    async create() {
      createdSources.push(undefined);
      return makeSandbox("new-sandbox");
    },
    async connect(id) {
      return connectResult(id);
    },
    async restore(name) {
      createdSources.push(name);
      if (!checkpoints.some((checkpoint) => checkpoint.key === name)) {
        throw new Error(`No checkpoint named ${name}`);
      }
      return makeSandbox("restored-sandbox");
    },
    async listCheckpoints() {
      return checkpoints;
    },
    async deleteCheckpoint(id) {
      checkpoints = checkpoints.filter((checkpoint) => checkpoint.id !== id);
    },
  };
}

function manager() {
  return new SandboxManager(provider(), {
    model: "test/model",
    sandboxEnv: {},
    configHash: "hash",
  });
}

function task(
  channelId: string,
  overrides: Partial<TaskRecord> = {},
): TaskRecord {
  return {
    channelId,
    kind: "feature",
    repo: "owner/repo",
    refNumber: 12,
    branch: "feat/12",
    sandboxId: "gone-sandbox",
    status: "ready",
    configHash: "hash",
    statusMessageId: null,
    model: null,
    context: null,
    createdBy: null,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("SandboxManager recovery", () => {
  beforeEach(() => {
    createdSources.length = 0;
    checkpoints = [];
    connectResult = async () => {
      throw new Error("sandbox gone");
    };
  });

  test("restores from a checkpoint instead of rebuilding", async () => {
    const channelId = "restore-channel";
    checkpoints = [{ id: "cp-1", key: checkpointNameForChannel(channelId) }];
    let rebuilt = false;

    const result = await manager().getOrCreate({
      task: task(channelId),
      onRebuild: () => {
        rebuilt = true;
      },
    });

    expect(result).toEqual({
      sandbox: expect.objectContaining({ id: "restored-sandbox" }),
      rebuilt: false,
      restored: true,
      configHash: "hash",
    });
    expect(rebuilt).toBe(false);
    expect(createdSources).toEqual([checkpointNameForChannel(channelId)]);
  });

  test("rebuilds when no checkpoint exists", async () => {
    const channelId = "rebuild-channel";
    let rebuilds = 0;

    const result = await manager().getOrCreate({
      task: task(channelId),
      onRebuild: () => {
        rebuilds += 1;
      },
    });

    expect(result).toEqual({
      sandbox: expect.objectContaining({ id: "new-sandbox" }),
      rebuilt: true,
      restored: false,
      configHash: "hash",
    });
    expect(rebuilds).toBe(1);
  });

  test("reuses a connected sandbox without restoring or rebuilding", async () => {
    const channelId = "live-channel";
    connectResult = async (id) => makeSandbox(id);
    let rebuilds = 0;

    const result = await manager().getOrCreate({
      task: task(channelId),
      onRebuild: () => {
        rebuilds += 1;
      },
    });

    expect(result).toEqual({
      sandbox: expect.objectContaining({ id: "gone-sandbox" }),
      rebuilt: false,
      restored: false,
      configHash: "hash",
    });
    expect(rebuilds).toBe(0);
  });

  test("deletes the checkpoint when the sandbox is destroyed", async () => {
    const channelId = "destroy-channel";
    checkpoints = [{ id: "cp-1", key: checkpointNameForChannel(channelId) }];

    await manager().destroy(channelId, "sandbox-id");

    expect(checkpoints).toEqual([]);
  });
});
