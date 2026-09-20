import { describe, expect, test } from "bun:test";
import type {
  ExecHandle,
  ExecOptions,
  SandboxHandle,
} from "../src/core/ports";
import type { TaskRecord } from "../src/core/ports";
import {
  configureSandboxTracing,
  phoenixProjectName,
} from "../src/core/tracing";

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    channelId: "1551102174853857290",
    kind: "feature",
    repo: "blindmansion/umbrella",
    refNumber: 14,
    branch: "feat/14-example",
    sandboxId: null,
    status: "provisioning",
    configHash: null,
    statusMessageId: null,
    model: null,
    context: null,
    createdAt: 0,
    ...overrides,
  };
}

function fakeSandbox(result = { exitCode: 0, stdout: "", stderr: "", timedOut: false }) {
  const calls: { command: string; env: Record<string, string> }[] = [];
  const sandbox: SandboxHandle = {
    id: "sandbox",
    exec(command: string, options: ExecOptions = {}) {
      calls.push({ command, env: options.env ?? {} });
      return Promise.resolve(result) as ExecHandle;
    },
    async writeFile() {},
    async mkdir() {},
    async checkpoint() {},
    async destroy() {},
  };
  return { sandbox, calls };
}

describe("phoenixProjectName", () => {
  test("groups issue and pull request tasks by repository", () => {
    expect(phoenixProjectName(task(), "Blind Mansion")).toBe(
      "blindmansion-umbrella",
    );
    expect(phoenixProjectName(task({ refNumber: 99 }), "Blind Mansion")).toBe(
      "blindmansion-umbrella",
    );
  });

  test("groups general questions under the Discord server", () => {
    expect(phoenixProjectName(task({ refNumber: null }), "Blind Mansion")).toBe(
      "Blind-Mansion",
    );
  });

  test("keeps the server name safe for the installer's dotenv file", () => {
    expect(
      phoenixProjectName(task({ refNumber: null }), "Tony's #1 server\n"),
    ).toBe("Tony-s-1-server");
  });

  test("falls back to the repository when the server name is unusable", () => {
    expect(phoenixProjectName(task({ refNumber: null }))).toBe(
      "blindmansion-umbrella",
    );
    expect(phoenixProjectName(task({ refNumber: null }), " '' ")).toBe(
      "blindmansion-umbrella",
    );
  });
});

describe("configureSandboxTracing", () => {
  const tracing = {
    endpoint: "http://phoenix.railway.internal:6006",
    apiKey: "key",
    logContent: true,
  };

  test("passes the project name through the installer's env file", async () => {
    const { sandbox, calls } = fakeSandbox();

    const projectName = await configureSandboxTracing({
      sandbox,
      task: task({ refNumber: null }),
      tracing,
      guildName: "Blind Mansion",
    });

    expect(projectName).toBe("Blind-Mansion");
    expect(calls[0]?.env.UMBRELLA_PHOENIX_PROJECT).toBe("Blind-Mansion");
    expect(calls[0]?.env.ARIZE_PROJECT_NAME).toBeUndefined();
    expect(calls[0]?.command).toContain("export ARIZE_ENV_FILE");
    expect(calls[0]?.command).toContain("ARIZE_PROJECT_NAME='%s'");
  });

  test("enables content logging unless it is turned off", async () => {
    const enabled = fakeSandbox();
    await configureSandboxTracing({ sandbox: enabled.sandbox, task: task(), tracing });
    expect(enabled.calls[0]?.env.ARIZE_LOG_PROMPTS).toBe("true");
    expect(enabled.calls[0]?.env.ARIZE_LOG_TOOL_DETAILS).toBe("true");
    expect(enabled.calls[0]?.env.ARIZE_LOG_TOOL_CONTENT).toBe("true");

    const disabled = fakeSandbox();
    await configureSandboxTracing({
      sandbox: disabled.sandbox,
      task: task(),
      tracing: { ...tracing, logContent: false },
    });
    expect(disabled.calls[0]?.env.ARIZE_LOG_PROMPTS).toBe("false");
  });

  test("surfaces installer failures", async () => {
    const { sandbox } = fakeSandbox({
      exitCode: 1,
      stdout: "",
      stderr: "boom",
      timedOut: false,
    });
    await expect(
      configureSandboxTracing({ sandbox, task: task(), tracing }),
    ).rejects.toThrow("boom");
  });
});
