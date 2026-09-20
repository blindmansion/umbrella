import type { SandboxHandle, TaskRecord } from "../core/ports";

export type SandboxTracing = {
  /** Phoenix base URL reachable from inside a Railway sandbox. */
  endpoint: string;
  /** System API key, required when Phoenix runs with authentication enabled. */
  apiKey?: string;
  /** Export prompts, responses, and tool input/output instead of redacting them. */
  logContent: boolean;
};

const installerUrl =
  "https://raw.githubusercontent.com/Arize-ai/coding-harness-tracing/main/install.sh";

/**
 * Traces are grouped into one Phoenix project per repository. Tasks that are
 * not tied to a GitHub issue or pull request are general questions, so they
 * share a project named after the Discord server when its name is known.
 */
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

/** Keep names safe for the installer's dotenv file and for Phoenix URLs. */
function projectSlug(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Install and configure the Arize OpenCode tracing harness inside a freshly
 * created sandbox. The harness writes an opencode plugin plus a per-session
 * project config so OpenCode exports OpenInference spans straight to Phoenix.
 */
export async function configureSandboxTracing(options: {
  sandbox: SandboxHandle;
  task: TaskRecord;
  tracing: SandboxTracing;
  guildName?: string;
}): Promise<string> {
  const { sandbox, task, tracing, guildName } = options;
  const projectName = phoenixProjectName(task, guildName);
  // A non-interactive install redacts all content unless each flag is set.
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
    // The installer ignores an ambient ARIZE_PROJECT_NAME and only accepts the
    // project name from the dotenv file named by ARIZE_ENV_FILE. Without it
    // every task lands in the harness default project, "opencode".
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
