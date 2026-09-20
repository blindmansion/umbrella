import { createHash } from "node:crypto";
import { Sandbox, type SandboxNetworkIsolation } from "railway";
import { shellQuote } from "./opencode";
import type { TaskRecord } from "./store";
import { configureSandboxTracing, type SandboxTracing } from "./tracing";

const liveSandboxes = new Map<string, Sandbox>();
const channelQueues = new Map<string, Promise<unknown>>();
const channelQueueDepths = new Map<string, number>();

export function computeConfigHash(
  model: string,
  sandboxEnv: Record<string, string>,
  extra: Record<string, unknown> = {},
): string {
  return createHash("sha256")
    .update(JSON.stringify({ model, sandboxEnv, ...extra }))
    .digest("hex");
}

export function runExclusive<T>(
  channelId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = channelQueues.get(channelId) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(fn);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );

  channelQueues.set(channelId, tail);
  channelQueueDepths.set(channelId, queueDepth(channelId) + 1);

  return result.finally(() => {
    const remaining = queueDepth(channelId) - 1;
    if (remaining > 0) {
      channelQueueDepths.set(channelId, remaining);
    } else {
      channelQueueDepths.delete(channelId);
    }
    if (channelQueues.get(channelId) === tail) {
      channelQueues.delete(channelId);
    }
  });
}

export function queueDepth(channelId: string): number {
  return channelQueueDepths.get(channelId) ?? 0;
}

export async function getOrCreateSandbox(options: {
  task: TaskRecord;
  sandboxEnv: Record<string, string>;
  configHash: string;
  githubToken?: string;
  tracing?: SandboxTracing;
  networkIsolation?: SandboxNetworkIsolation;
  onRebuild?: () => void | Promise<void>;
}): Promise<{ sandbox: Sandbox; rebuilt: boolean }> {
  const {
    task,
    sandboxEnv,
    configHash,
    githubToken,
    tracing,
    networkIsolation,
    onRebuild,
  } = options;
  const cached = liveSandboxes.get(task.channelId);
  const configurationMatches = task.configHash === configHash;

  if (
    cached &&
    configurationMatches &&
    task.sandboxId === cached.id
  ) {
    return { sandbox: cached, rebuilt: false };
  }

  if (!configurationMatches) {
    liveSandboxes.delete(task.channelId);
    if (cached) {
      await cached.destroy().catch((error) => {
        console.warn(
          `Could not destroy stale sandbox ${cached.id}:`,
          sanitizeError(error, githubToken),
        );
      });
    }
    if (task.sandboxId && task.sandboxId !== cached?.id) {
      const staleSandbox = await Sandbox.connect(task.sandboxId).catch(
        () => undefined,
      );
      await staleSandbox?.destroy().catch((error) => {
        console.warn(
          `Could not destroy stale sandbox ${task.sandboxId}:`,
          sanitizeError(error, githubToken),
        );
      });
    }
  } else if (cached) {
    liveSandboxes.delete(task.channelId);
    await cached.destroy().catch((error) => {
      console.warn(
        `Could not destroy replaced sandbox ${cached.id}:`,
        sanitizeError(error, githubToken),
      );
    });
    if (task.sandboxId) {
      try {
        const sandbox = await Sandbox.connect(task.sandboxId);
        liveSandboxes.set(task.channelId, sandbox);
        return { sandbox, rebuilt: false };
      } catch (error) {
        console.warn(
          `Could not reconnect to sandbox ${task.sandboxId}; creating a new one:`,
          sanitizeError(error, githubToken),
        );
      }
    }
  } else if (task.sandboxId) {
    try {
      const sandbox = await Sandbox.connect(task.sandboxId);
      liveSandboxes.set(task.channelId, sandbox);
      return { sandbox, rebuilt: false };
    } catch (error) {
      console.warn(
        `Could not reconnect to sandbox ${task.sandboxId}; creating a new one:`,
        sanitizeError(error, githubToken),
      );
    }
  }

  const sandbox = await Sandbox.create({
    idleTimeoutMinutes: 60,
    env: sandboxEnv,
    networkIsolation,
  });

  try {
    await bootstrapSandbox(sandbox, task, githubToken, tracing);
  } catch (error) {
    await sandbox.destroy().catch(() => undefined);
    throw error;
  }

  liveSandboxes.set(task.channelId, sandbox);
  await onRebuild?.();
  return { sandbox, rebuilt: true };
}

export async function bootstrapSandbox(
  sandbox: Sandbox,
  task: TaskRecord,
  githubToken?: string,
  tracing?: SandboxTracing,
): Promise<void> {
  const encodedToken = githubToken
    ? encodeURIComponent(githubToken)
    : undefined;
  const cloneUrl = encodedToken
    ? `https://x-access-token:${encodedToken}@github.com/${task.repo}.git`
    : `https://github.com/${task.repo}.git`;

  await runRequired(
    sandbox,
    'if [ -n "${GIT_AUTHOR_NAME:-}" ]; then git config --global user.name "$GIT_AUTHOR_NAME"; fi; if [ -n "${GIT_AUTHOR_EMAIL:-}" ]; then git config --global user.email "$GIT_AUTHOR_EMAIL"; fi',
    "configure git author",
    30,
    githubToken,
  );

  await runRequired(
    sandbox,
    `git clone -- ${shellQuote(cloneUrl)} /root/workspace`,
    "clone repository",
    300,
    githubToken,
  );

  if (task.kind === "feature") {
    await runRequired(
      sandbox,
      `git checkout -b ${shellQuote(task.branch)}`,
      `create branch ${task.branch}`,
      120,
      githubToken,
      "/root/workspace",
    );
  } else if (task.kind === "bugfix" || task.kind === "review") {
    await runRequired(
      sandbox,
      `git checkout ${shellQuote(task.branch)}`,
      `check out branch ${task.branch}`,
      120,
      githubToken,
      "/root/workspace",
    );
  }

  const installResult = await sandbox
    .exec(
      "if [ -f bun.lock ] || [ -f bun.lockb ]; then bun install; elif [ -f package.json ]; then npm install; fi",
      {
        cwd: "/root/workspace",
        timeoutSec: 600,
      },
    )
    .catch((error) => {
      console.warn(
        `Dependency install failed (continuing): ${sanitizeError(error, githubToken)}`,
      );
      return undefined;
    });

  if (
    installResult &&
    (installResult.timedOut || installResult.exitCode !== 0)
  ) {
    const detail = sanitizeText(
      installResult.stderr.trim() ||
        installResult.stdout.trim() ||
        (installResult.timedOut
          ? "dependency install timed out"
          : `dependency install exited with code ${installResult.exitCode}`),
      githubToken,
    );
    console.warn(`Dependency install failed (continuing): ${detail}`);
  }

  if (tracing) {
    try {
      const projectName = await configureSandboxTracing({
        sandbox,
        task,
        tracing,
      });
      console.log(
        `Tracing channel ${task.channelId} into Phoenix project ${projectName}`,
      );
    } catch (error) {
      console.warn(
        `Could not configure OpenCode tracing (continuing): ${sanitizeError(error, githubToken)}`,
      );
    }
  }
}

export async function destroySandbox(
  channelId: string,
  sandboxId?: string,
): Promise<void> {
  const cached = liveSandboxes.get(channelId);
  liveSandboxes.delete(channelId);

  if (cached) {
    await cached.destroy().catch((error) => {
      console.warn(`Could not destroy sandbox ${cached.id}:`, error);
    });
    return;
  }

  if (sandboxId) {
    const sandbox = await Sandbox.connect(sandboxId).catch(() => undefined);
    await sandbox?.destroy().catch((error) => {
      console.warn(`Could not destroy sandbox ${sandboxId}:`, error);
    });
  }
}

async function runRequired(
  sandbox: Sandbox,
  command: string,
  description: string,
  timeoutSec: number,
  secret?: string,
  cwd?: string,
): Promise<void> {
  let result;
  try {
    result = await sandbox.exec(command, { cwd, timeoutSec });
  } catch (error) {
    throw new Error(
      `Could not ${description}: ${sanitizeError(error, secret)}`,
    );
  }

  if (result.timedOut) {
    throw new Error(`Could not ${description}: command timed out`);
  }
  if (result.exitCode !== 0) {
    const detail = sanitizeText(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `command exited with code ${result.exitCode}`,
      secret,
    );
    throw new Error(`Could not ${description}: ${detail}`);
  }
}

function sanitizeError(error: unknown, secret?: string): string {
  return sanitizeText(
    error instanceof Error ? error.message : String(error),
    secret,
  );
}

function sanitizeText(value: string, secret?: string): string {
  let sanitized = value;
  if (secret) {
    sanitized = sanitized.replaceAll(secret, "[redacted]");
    sanitized = sanitized.replaceAll(
      encodeURIComponent(secret),
      "[redacted]",
    );
  }
  return sanitized.replace(
    /https:\/\/[^@\s]+@github\.com/gi,
    "https://[redacted]@github.com",
  );
}
