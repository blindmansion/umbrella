import { describe, expect, test } from "bun:test";
import type {
  ExecHandle,
  SandboxHandle,
  SandboxProvider,
  TaskRecord,
} from "../src/core/ports";
import { SandboxManager } from "../src/core/sandboxes";

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    channelId: "channel-1",
    kind: "planning",
    repo: "owner/repo",
    refNumber: null,
    branch: "main",
    sandboxId: null,
    status: "provisioning",
    configHash: null,
    statusMessageId: null,
    model: null,
    context: null,
    createdAt: 1,
    ...overrides,
  };
}

function handle(
  id: string,
  options: { failClone?: boolean } = {},
): SandboxHandle & { destroyed: boolean; commands: string[] } {
  return {
    id,
    destroyed: false,
    commands: [],
    exec(command) {
      this.commands.push(command);
      const failed = options.failClone && command.startsWith("git clone");
      return Promise.resolve({
        exitCode: failed ? 1 : 0,
        stdout: "",
        stderr: failed ? "token=secret clone failed" : "",
        timedOut: false,
      }) as ExecHandle;
    },
    async mkdir() {},
    async writeFile() {},
    async destroy() {
      this.destroyed = true;
    },
  };
}

describe("SandboxManager", () => {
  test("falls through to a new sandbox when reconnecting fails", async () => {
    const created = handle("new-sandbox");
    const provider: SandboxProvider = {
      async connect() {
        throw new Error("gone");
      },
      async create() {
        return created;
      },
    };
    const manager = new SandboxManager(provider, {
      model: "test/model",
      sandboxEnv: {},
      configHash: "hash",
    });

    const result = await manager.getOrCreate({
      task: task({ sandboxId: "old-sandbox", configHash: "hash" }),
    });

    expect(result).toEqual({ sandbox: created, rebuilt: true });
    expect(created.commands.some((command) => command.startsWith("git clone"))).toBe(true);
  });

  test("destroys stale sandboxes when the config hash changes", async () => {
    const stale = handle("stale");
    const replacement = handle("replacement");
    const provider: SandboxProvider = {
      async connect(id) {
        expect(id).toBe("stale");
        return stale;
      },
      async create() {
        return replacement;
      },
    };
    const manager = new SandboxManager(provider, {
      model: "test/model",
      sandboxEnv: {},
      configHash: "new-hash",
    });

    const result = await manager.getOrCreate({
      task: task({ sandboxId: "stale", configHash: "old-hash" }),
    });

    expect(stale.destroyed).toBe(true);
    expect(result.sandbox.id).toBe("replacement");
    expect(result.rebuilt).toBe(true);
  });

  test("destroys a half-built sandbox and redacts bootstrap errors", async () => {
    const broken = handle("broken", { failClone: true });
    const provider: SandboxProvider = {
      async connect() {
        throw new Error("unused");
      },
      async create() {
        return broken;
      },
    };
    const manager = new SandboxManager(provider, {
      model: "test/model",
      sandboxEnv: { API_KEY: "secret" },
      githubToken: "secret",
      configHash: "hash",
    });

    await expect(
      manager.getOrCreate({ task: task() }),
    ).rejects.toThrow("[redacted]");
    expect(broken.destroyed).toBe(true);
  });
});
