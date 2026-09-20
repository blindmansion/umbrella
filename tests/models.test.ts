import { describe, expect, test } from "bun:test";
import type { ExecHandle, SandboxHandle } from "../src/core/ports";
import { parseModelList } from "../src/core/opencode";
import { SandboxManager } from "../src/core/sandboxes";

function fakeSandbox(outputs: string[]): {
  sandbox: SandboxHandle;
  calls: () => number;
} {
  let calls = 0;
  const sandbox = {
    id: "models-sandbox",
    exec: () => {
      const output = outputs[Math.min(calls, outputs.length - 1)] ?? "";
      calls += 1;
      return Promise.resolve({
        exitCode: 0,
        stdout: output,
        stderr: "",
        timedOut: false,
      }) as ExecHandle;
    },
    async writeFile() {},
    async mkdir() {},
    async checkpoint() {},
    async destroy() {},
  };
  return { sandbox, calls: () => calls };
}

function manager() {
  return new SandboxManager(
    {
      async create() {
        throw new Error("unused");
      },
      async connect() {
        throw new Error("unused");
      },
      async restore() {
        throw new Error("unused");
      },
      async listCheckpoints() {
        return [];
      },
      async deleteCheckpoint() {},
    },
    { model: "test/model", sandboxEnv: {}, configHash: "hash" },
  );
}

describe("parseModelList", () => {
  test("parses provider/model lines and ignores noise", () => {
    const output = [
      "fireworks-ai/accounts/fireworks/models/deepseek-v4p1-flash",
      "",
      "  anthropic/claude-sonnet-4-6  ",
      "not a model line",
      "fireworks-ai/accounts/fireworks/models/deepseek-v4p1-flash",
      "fireworks-ai/models/glm-5p3",
    ].join("\n");

    expect(parseModelList(output)).toEqual([
      "fireworks-ai/accounts/fireworks/models/deepseek-v4p1-flash",
      "anthropic/claude-sonnet-4-6",
      "fireworks-ai/models/glm-5p3",
    ]);
  });

  test("returns nothing for empty output", () => {
    expect(parseModelList("")).toEqual([]);
  });
});

describe("getAvailableModels", () => {
  test("lists models from the sandbox and caches the result", async () => {
    const models = manager();
    models.clearModelCache();
    const { sandbox, calls } = fakeSandbox([
      "anthropic/claude-sonnet-4-6\nfireworks-ai/models/glm-5p3\n",
    ]);

    const first = await models.availableModels("channel-1", sandbox);
    const second = await models.availableModels("channel-1", sandbox);

    expect(first).toEqual([
      "anthropic/claude-sonnet-4-6",
      "fireworks-ai/models/glm-5p3",
    ]);
    expect(second).toEqual(first);
    expect(calls()).toBe(1);
  });

  test("refresh bypasses the cache", async () => {
    const models = manager();
    models.clearModelCache();
    const { sandbox, calls } = fakeSandbox([
      "anthropic/claude-sonnet-4-6\n",
      "anthropic/claude-opus-4-6\n",
    ]);

    await models.availableModels("channel-refresh", sandbox);
    const refreshed = await models.availableModels("channel-refresh", sandbox, {
      refresh: true,
    });

    expect(refreshed).toEqual(["anthropic/claude-opus-4-6"]);
    expect(calls()).toBe(2);
  });
});
