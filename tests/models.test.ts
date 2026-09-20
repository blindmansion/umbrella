import { describe, expect, test } from "bun:test";
import type { Sandbox } from "railway";
import { clearModelCache, getAvailableModels } from "../src/opencode/models";
import { parseModelList } from "../src/opencode/runner";

function fakeSandbox(outputs: string[]): {
  sandbox: Sandbox;
  calls: () => number;
} {
  let calls = 0;
  const sandbox = {
    exec: async () => {
      const output = outputs[Math.min(calls, outputs.length - 1)] ?? "";
      calls += 1;
      return { exitCode: 0, stdout: output, stderr: "", timedOut: false };
    },
  } as unknown as Sandbox;
  return { sandbox, calls: () => calls };
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
    clearModelCache();
    const { sandbox, calls } = fakeSandbox([
      "anthropic/claude-sonnet-4-6\nfireworks-ai/models/glm-5p3\n",
    ]);

    const first = await getAvailableModels("channel-1", sandbox);
    const second = await getAvailableModels("channel-1", sandbox);

    expect(first).toEqual([
      "anthropic/claude-sonnet-4-6",
      "fireworks-ai/models/glm-5p3",
    ]);
    expect(second).toEqual(first);
    expect(calls()).toBe(1);
  });

  test("refresh bypasses the cache", async () => {
    clearModelCache();
    const { sandbox, calls } = fakeSandbox([
      "anthropic/claude-sonnet-4-6\n",
      "anthropic/claude-opus-4-6\n",
    ]);

    await getAvailableModels("channel-refresh", sandbox);
    const refreshed = await getAvailableModels("channel-refresh", sandbox, {
      refresh: true,
    });

    expect(refreshed).toEqual(["anthropic/claude-opus-4-6"]);
    expect(calls()).toBe(2);
  });
});
