import type { SandboxHandle, TaskRecord } from "./ports";

export type SandboxTracing = {
  endpoint: string;
  apiKey?: string;
  logContent: boolean;
};

const installerUrl =
  "https://raw.githubusercontent.com/Arize-ai/coding-harness-tracing/main/install.sh";

export function phoenixProjectName(
  task: TaskRecord,
  guildName?: string,
): string {
  if (task.refNumber === null) {
    const server = projectSlug(guildName ?? "");
    if (server) return server;
  }
  return projectSlug(task.repo) || `umbrella-${task.channelId}`;
}

function projectSlug(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

export async function configureSandboxTracing(options: {
  sandbox: SandboxHandle;
  task: TaskRecord;
  tracing: SandboxTracing;
  guildName?: string;
}): Promise<string> {
  const { sandbox, task, tracing, guildName } = options;
  const projectName = phoenixProjectName(task, guildName);
  const logContent = tracing.logContent ? "true" : "false";
  const env: Record<string, string> = {
    ARIZE_NONINTERACTIVE: "1",
    ARIZE_BACKEND: "phoenix",
    PHOENIX_ENDPOINT: tracing.endpoint,
    ARIZE_LOG_PROMPTS: logContent,
    ARIZE_LOG_TOOL_DETAILS: logContent,
    ARIZE_LOG_TOOL_CONTENT: logContent,
    UMBRELLA_PHOENIX_PROJECT: projectName,
  };
  if (tracing.apiKey) env.PHOENIX_API_KEY = tracing.apiKey;

  const command = [
    "set -eu",
    "if ! command -v python3 >/dev/null 2>&1; then echo 'python3 is required for OpenCode tracing' >&2; exit 1; fi",
    "if ! python3 -m venv --help >/dev/null 2>&1; then (apt-get update && apt-get install -y python3-venv) >/dev/null 2>&1 || true; fi",
    'ARIZE_ENV_FILE="$(mktemp)"',
    "export ARIZE_ENV_FILE",
    `printf "ARIZE_PROJECT_NAME='%s'\\n" "$UMBRELLA_PHOENIX_PROJECT" > "$ARIZE_ENV_FILE"`,
    `curl -fsSL ${installerUrl} | bash -s -- opencode --non-interactive`,
    'rm -f "$ARIZE_ENV_FILE"',
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
