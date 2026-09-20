import type { Sandbox } from "railway";
import type { TaskRecord } from "./store";

export type SandboxTracing = {
  /** Phoenix base URL reachable from inside a Railway sandbox. */
  endpoint: string;
  /** System API key, required when Phoenix runs with authentication enabled. */
  apiKey?: string;
};

const installerUrl =
  "https://raw.githubusercontent.com/Arize-ai/coding-harness-tracing/main/install.sh";

/**
 * Each umbrella task channel maps to its own Phoenix project so a channel's
 * traces stay isolated. The name is derived from the repository and reference
 * so it is stable across sandbox rebuilds.
 */
export function phoenixProjectName(task: TaskRecord): string {
  const reference =
    task.refNumber === null ? task.repo : `${task.repo}-${task.refNumber}`;
  const slug = reference
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return `umbrella-${slug || task.channelId}`;
}

/**
 * Install and configure the Arize OpenCode tracing harness inside a freshly
 * created sandbox. The harness writes an opencode plugin plus a per-session
 * project config so OpenCode exports OpenInference spans straight to Phoenix.
 */
export async function configureSandboxTracing(options: {
  sandbox: Sandbox;
  task: TaskRecord;
  tracing: SandboxTracing;
}): Promise<string> {
  const { sandbox, task, tracing } = options;
  const projectName = phoenixProjectName(task);
  const env: Record<string, string> = {
    ARIZE_NONINTERACTIVE: "1",
    ARIZE_BACKEND: "phoenix",
    PHOENIX_ENDPOINT: tracing.endpoint,
    ARIZE_PROJECT_NAME: projectName,
  };
  if (tracing.apiKey) env.PHOENIX_API_KEY = tracing.apiKey;

  const command = [
    "set -eu",
    "if ! command -v python3 >/dev/null 2>&1; then echo 'python3 is required for OpenCode tracing' >&2; exit 1; fi",
    "if ! python3 -m venv --help >/dev/null 2>&1; then (apt-get update && apt-get install -y python3-venv) >/dev/null 2>&1 || true; fi",
    `curl -fsSL ${installerUrl} | bash -s -- opencode --non-interactive`,
  ].join("\n");

  const result = await sandbox.exec(command, { env, timeoutSec: 600 });
  if (result.timedOut) {
    throw new Error("OpenCode tracing installer timed out");
  }
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `OpenCode tracing installer exited with code ${result.exitCode}`,
    );
  }
  return projectName;
}
