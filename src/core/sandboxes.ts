import { installSandboxAgentInstructions } from "./agents";
import { listOpenCodeModels } from "./opencode";
import type {
  CoreConfig,
  CredentialResolver,
  SandboxHandle,
  SandboxProvider,
  SandboxUserConfig,
  SessionRecord,
  TaskRecord,
} from "./ports";
import { configureSandboxTracing } from "./tracing";
import { sanitizeError, sanitizeText, shellQuote } from "./utils";
import {
  buildWorktreeCommand,
  type SessionWorkspace,
  worktreeBranchFor,
  worktreePathFor,
} from "./worktrees";

type ModelCacheEntry = { models: string[]; fetchedAt: number };

const SANDBOX_IDLE_TIMEOUT_MINUTES = 60;

export type SandboxResolution = {
  sandbox: SandboxHandle;
  /** A brand-new sandbox was bootstrapped because none could be reused. */
  rebuilt: boolean;
  /** The sandbox was booted from a checkpoint, so its OpenCode sessions remain valid. */
  restored: boolean;
  /** The effective configuration hash the sandbox was built with. */
  configHash: string;
};

/** Environment-scoped checkpoint name. Task channels are unique, so one each. */
export function checkpointNameForChannel(channelId: string): string {
  return `umbrella-${channelId}`;
}

export class SandboxManager {
  private readonly live = new Map<string, SandboxHandle>();
  private readonly modelCache = new Map<string, ModelCacheEntry>();
  private readonly modelRequests = new Map<string, Promise<string[]>>();

  constructor(
    private readonly provider: SandboxProvider,
    private readonly config: CoreConfig,
    private readonly resolveCredentials?: CredentialResolver,
  ) {}

  async getOrCreate(options: {
    task: TaskRecord;
    guildName?: string;
    onRebuild?: () => void | Promise<void>;
  }): Promise<SandboxResolution> {
    const { task, guildName, onRebuild } = options;
    const userConfig = await this.resolveCredentials?.(task);
    const configHash = effectiveConfigHash(this.config.configHash, userConfig);
    const env = sandboxEnvFor(this.config, userConfig);
    const token = userConfig?.githubToken ?? this.config.githubToken;
    const cached = this.live.get(task.channelId);
    const matches = task.configHash === configHash;

    if (cached && matches && task.sandboxId === cached.id) {
      return { sandbox: cached, rebuilt: false, restored: false, configHash };
    }

    if (!matches) {
      this.live.delete(task.channelId);
      await this.destroyHandle(cached, "stale");
      if (task.sandboxId && task.sandboxId !== cached?.id) {
        const stale = await this.provider
          .connect(task.sandboxId)
          .catch(() => undefined);
        await this.destroyHandle(stale, "stale");
      }
      await this.deleteCheckpoint(task.channelId);
    } else {
      if (cached) {
        this.live.delete(task.channelId);
        await this.destroyHandle(cached, "replaced");
      }
      if (task.sandboxId) {
        const connected = await this.connect(task.channelId, task.sandboxId);
        if (connected) {
          return { sandbox: connected, rebuilt: false, restored: false, configHash };
        }
      }
      const restored = await this.restoreFromCheckpoint(task.channelId, env);
      if (restored) {
        this.live.set(task.channelId, restored);
        this.clearModelCache(task.channelId);
        return { sandbox: restored, rebuilt: false, restored: true, configHash };
      }
    }

    const sandbox = await this.provider.create({
      idleTimeoutMinutes: SANDBOX_IDLE_TIMEOUT_MINUTES,
      env,
      networkIsolation: this.config.networkIsolation,
    });
    try {
      await this.bootstrap(sandbox, task, guildName, token);
      await this.captureCheckpoint(sandbox, task.channelId);
    } catch (error) {
      await sandbox.destroy().catch(() => undefined);
      throw error;
    }

    this.live.set(task.channelId, sandbox);
    this.clearModelCache(task.channelId);
    await onRebuild?.();
    return { sandbox, rebuilt: true, restored: false, configHash };
  }

  async getExisting(
    channelId: string,
    sandboxId?: string | null,
  ): Promise<SandboxHandle | undefined> {
    const cached = this.live.get(channelId);
    if (cached) return cached;
    if (!sandboxId) return undefined;
    return this.connect(channelId, sandboxId);
  }

  async ensureWorktree(options: {
    sandbox: SandboxHandle;
    task: TaskRecord;
    threadId: string;
    session?: Pick<SessionRecord, "worktreePath" | "branch"> | undefined;
  }): Promise<SessionWorkspace> {
    const { sandbox, task, threadId, session } = options;
    const path = session?.worktreePath ?? worktreePathFor(threadId);
    const branch = session?.branch ?? worktreeBranchFor(task.branch, threadId);
    await this.runRequired(
      sandbox,
      buildWorktreeCommand({ path, branch, startPoint: task.branch }),
      `create a worktree for thread ${threadId}`,
      300,
      "/root/workspace",
    );
    return { path, branch };
  }

  async destroy(channelId: string, sandboxId?: string | null): Promise<void> {
    const cached = this.live.get(channelId);
    this.live.delete(channelId);
    this.clearModelCache(channelId);
    if (cached) {
      await this.destroyHandle(cached, "");
    } else if (sandboxId) {
      const sandbox = await this.provider
        .connect(sandboxId)
        .catch(() => undefined);
      await this.destroyHandle(sandbox, "");
    }
    await this.deleteCheckpoint(channelId);
  }

  /**
   * Snapshot the sandbox disk so a future teardown can be recovered with its
   * repository state and OpenCode sessions intact. Best-effort.
   */
  async captureCheckpoint(
    sandbox: SandboxHandle,
    channelId: string,
  ): Promise<void> {
    const name = checkpointNameForChannel(channelId);
    const startedAt = Date.now();
    try {
      await sandbox.checkpoint(name);
      console.log(
        `Captured checkpoint ${name} for channel ${channelId} in ${Date.now() - startedAt}ms`,
      );
    } catch (error) {
      console.warn(
        `Could not capture checkpoint ${name} for channel ${channelId}:`,
        sanitizeError(error),
      );
    }
  }

  async availableModels(
    channelId: string,
    sandbox: SandboxHandle,
    options: { refresh?: boolean; cacheTtlMs?: number } = {},
  ): Promise<string[]> {
    const cached = this.modelCache.get(channelId);
    const ttl = options.cacheTtlMs ?? 5 * 60_000;
    if (
      cached &&
      !options.refresh &&
      Date.now() - cached.fetchedAt < ttl
    ) {
      return cached.models;
    }
    const pending = this.modelRequests.get(channelId);
    if (pending) return pending;
    const request = listOpenCodeModels(sandbox)
      .then((models) => {
        this.modelCache.set(channelId, {
          models,
          fetchedAt: Date.now(),
        });
        return models;
      })
      .catch((error) => {
        console.warn(
          `Could not list OpenCode models for channel ${channelId}:`,
          sanitizeError(error),
        );
        return cached?.models ?? [];
      })
      .finally(() => this.modelRequests.delete(channelId));
    this.modelRequests.set(channelId, request);
    return request;
  }

  clearModelCache(channelId?: string): void {
    if (channelId === undefined) this.modelCache.clear();
    else this.modelCache.delete(channelId);
  }

  private async restoreFromCheckpoint(
    channelId: string,
    env: Record<string, string>,
  ): Promise<SandboxHandle | undefined> {
    const name = checkpointNameForChannel(channelId);
    try {
      const sandbox = await this.provider.restore(name, {
        idleTimeoutMinutes: SANDBOX_IDLE_TIMEOUT_MINUTES,
        env,
        networkIsolation: this.config.networkIsolation,
      });
      console.log(
        `Restored sandbox ${sandbox.id} for channel ${channelId} from checkpoint ${name}`,
      );
      return sandbox;
    } catch (error) {
      console.warn(
        `Could not restore sandbox for channel ${channelId} from checkpoint ${name}:`,
        sanitizeError(error, [this.config.githubToken ?? ""]),
      );
      return undefined;
    }
  }

  private async deleteCheckpoint(channelId: string): Promise<void> {
    const name = checkpointNameForChannel(channelId);
    try {
      const checkpoints = await this.provider.listCheckpoints();
      const match = checkpoints.find((checkpoint) => checkpoint.key === name);
      if (!match) return;
      await this.provider.deleteCheckpoint(match.id);
      console.log(`Deleted checkpoint ${name} for channel ${channelId}`);
    } catch (error) {
      console.warn(
        `Could not delete checkpoint ${name} for channel ${channelId}:`,
        sanitizeError(error),
      );
    }
  }

  private async connect(
    channelId: string,
    sandboxId: string,
  ): Promise<SandboxHandle | undefined> {
    try {
      const sandbox = await this.provider.connect(sandboxId);
      this.live.set(channelId, sandbox);
      return sandbox;
    } catch (error) {
      console.warn(
        `Could not reconnect to sandbox ${sandboxId}; creating a new one:`,
        sanitizeError(error, [this.config.githubToken ?? ""]),
      );
      return undefined;
    }
  }

  private async destroyHandle(
    sandbox: SandboxHandle | undefined,
    adjective: string,
  ): Promise<void> {
    if (!sandbox) return;
    await sandbox.destroy().catch((error) => {
      console.warn(
        `Could not destroy ${adjective ? `${adjective} ` : ""}sandbox ${sandbox.id}:`,
        sanitizeError(error, [this.config.githubToken ?? ""]),
      );
    });
  }

  private async bootstrap(
    sandbox: SandboxHandle,
    task: TaskRecord,
    guildName: string | undefined,
    token: string | undefined,
  ): Promise<void> {
    const cloneUrl = token
      ? `https://x-access-token:${encodeURIComponent(token)}@github.com/${task.repo}.git`
      : `https://github.com/${task.repo}.git`;

    await this.runRequired(
      sandbox,
      'if [ -n "${GIT_AUTHOR_NAME:-}" ]; then git config --global user.name "$GIT_AUTHOR_NAME"; fi; if [ -n "${GIT_AUTHOR_EMAIL:-}" ]; then git config --global user.email "$GIT_AUTHOR_EMAIL"; fi',
      "configure git author",
      30,
    );
    await this.runRequired(
      sandbox,
      `git clone -- ${shellQuote(cloneUrl)} /root/workspace`,
      "clone repository",
      300,
    );
    if (task.kind === "feature") {
      await this.runRequired(
        sandbox,
        `git checkout -b ${shellQuote(task.branch)}`,
        `create branch ${task.branch}`,
        120,
        "/root/workspace",
      );
    } else if (task.kind === "bugfix" || task.kind === "review") {
      await this.runRequired(
        sandbox,
        `git checkout ${shellQuote(task.branch)}`,
        `check out branch ${task.branch}`,
        120,
        "/root/workspace",
      );
    }

    await installSandboxAgentInstructions(sandbox);

    const install = await sandbox
      .exec(
        "if [ -f bun.lock ] || [ -f bun.lockb ]; then bun install; elif [ -f package.json ]; then npm install; fi",
        { cwd: "/root/workspace", timeoutSec: 600 },
      )
      .catch((error) => {
        console.warn(
          `Dependency install failed (continuing): ${sanitizeError(error, [token ?? ""])}`,
        );
        return undefined;
      });
    if (install && (install.timedOut || install.exitCode !== 0)) {
      console.warn(
        `Dependency install failed (continuing): ${sanitizeText(
          install.stderr.trim() ||
            install.stdout.trim() ||
            (install.timedOut
              ? "dependency install timed out"
              : `dependency install exited with code ${install.exitCode}`),
          [token ?? ""],
        )}`,
      );
    }

    if (this.config.tracing) {
      await configureSandboxTracing({
        sandbox,
        task,
        tracing: this.config.tracing,
        guildName,
      }).catch((error) => {
          console.warn(
            `Could not configure OpenCode tracing (continuing): ${sanitizeError(error, [token ?? ""])}`,
          );
        });
    }
  }

  private async runRequired(
    sandbox: SandboxHandle,
    command: string,
    description: string,
    timeoutSec: number,
    cwd?: string,
    env?: Record<string, string>,
  ): Promise<void> {
    const secrets = [
      this.config.githubToken ?? "",
      ...Object.values(this.config.sandboxEnv),
    ];
    let result;
    try {
      result = await sandbox.exec(command, { cwd, env, timeoutSec });
    } catch (error) {
      throw new Error(
        `Could not ${description}: ${sanitizeError(error, secrets)}`,
      );
    }
    if (result.timedOut) {
      throw new Error(`Could not ${description}: command timed out`);
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `Could not ${description}: ${sanitizeText(
          result.stderr.trim() ||
            result.stdout.trim() ||
            `command exited with code ${result.exitCode}`,
          secrets,
        )}`,
      );
    }
  }
}

/**
 * The user's stored configuration augments the deployment-wide sandbox
 * environment. A newer `version` forces a rebuild so a changed token or git
 * author takes effect on the next prompt.
 */
export function effectiveConfigHash(
  baseHash: string,
  userConfig: SandboxUserConfig | undefined,
): string {
  return userConfig ? `${baseHash}:u${userConfig.version}` : baseHash;
}

export function sandboxEnvFor(
  config: CoreConfig,
  userConfig: SandboxUserConfig | undefined,
): Record<string, string> {
  const env = { ...config.sandboxEnv };
  if (!userConfig) return env;
  if (userConfig.githubToken) {
    env.GITHUB_TOKEN = userConfig.githubToken;
    env.GH_TOKEN = userConfig.githubToken;
  }
  if (userConfig.gitAuthorName) {
    env.GIT_AUTHOR_NAME = userConfig.gitAuthorName;
    env.GIT_COMMITTER_NAME = userConfig.gitAuthorName;
  }
  if (userConfig.gitAuthorEmail) {
    env.GIT_AUTHOR_EMAIL = userConfig.gitAuthorEmail;
    env.GIT_COMMITTER_EMAIL = userConfig.gitAuthorEmail;
  }
  return env;
}
