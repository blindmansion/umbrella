import type {
  Command,
  Deps,
  GitHubMetadata,
  GitHubReference,
  RepoReference,
  TaskKind,
  TaskRecord,
} from "./ports";
import { ChannelQueue } from "./queue";
import { SandboxManager } from "./sandboxes";
import { sanitizeError } from "./utils";

export type ProvisionResult = {
  channelId: string;
  task: TaskRecord;
  provisioningError?: string;
};

export async function provisionFromCommand(
  deps: Deps,
  manager: SandboxManager,
  queue: ChannelQueue,
  command: Extract<Command, { type: "task" }>,
): Promise<ProvisionResult> {
  if (command.reference) {
    const metadata = await deps.github.fetchMetadata(command.reference);
    const kind =
      command.kind ??
      (command.reference.urlKind === "pull" ? "review" : "feature");
    if (kind === "review" && !metadata.headRef && !command.branch) {
      throw new Error(
        "I couldn't fetch this pull request's head branch. Provide an explicit branch.",
      );
    }
    const slug =
      slugify(metadata.title ?? "") ||
      `${command.reference.urlKind}-${command.reference.number}`;
    const branch = inferBranch({
      kind,
      number: command.reference.number,
      slug,
      explicitBranch: command.branch,
      metadata,
    });
    return provisionResolved(deps, manager, queue, command, {
      kind,
      repo: `${command.reference.owner}/${command.reference.name}`,
      refNumber: command.reference.number,
      branch,
      slug,
      context: referenceContext(command.reference, kind, branch, metadata),
    });
  }

  const repoInput =
    command.repo ?? (await deps.store.getGuildRepo(command.guildId))?.repo;
  const repo = repoInput ? parseRepoFullName(repoInput) : undefined;
  if (!repo) {
    throw new Error(
      repoInput
        ? `"${repoInput}" is not a valid owner/name repository.`
        : "This server doesn't have a task repository yet.",
    );
  }
  const repoName = `${repo.owner}/${repo.name}`;
  const branch =
    command.branch ??
    (await deps.github.fetchDefaultBranch(repo)) ??
    "main";
  const kind = command.kind ?? "planning";
  return provisionResolved(deps, manager, queue, command, {
    kind,
    repo: repoName,
    refNumber: null,
    branch,
    slug: slugify(command.prompt ?? "") || "task",
    context: repoContext(repoName, kind, branch, command.prompt),
  });
}

async function provisionResolved(
  deps: Deps,
  manager: SandboxManager,
  queue: ChannelQueue,
  command: Extract<Command, { type: "task" }>,
  resolved: {
    kind: TaskKind;
    repo: string;
    refNumber: number | null;
    branch: string;
    slug: string;
    context: string;
  },
): Promise<ProvisionResult> {
  const [owner, name] = resolved.repo.split("/");
  const channelId = await deps.chat.createTaskChannel({
    guildId: command.guildId,
    category: slugify(`${owner}-${name}`).slice(0, 100) || "tasks",
    name: createChannelName(
      resolved.kind,
      resolved.refNumber,
      resolved.slug,
    ),
    reason: `Task created by ${command.actorName}`,
  });
  const task: TaskRecord = {
    channelId,
    kind: resolved.kind,
    repo: resolved.repo,
    refNumber: resolved.refNumber,
    branch: resolved.branch,
    sandboxId: null,
    status: "provisioning",
    configHash: null,
    statusMessageId: null,
    model: null,
    context: resolved.context,
    createdAt: (deps.clock ?? Date.now)(),
  };
  await deps.store.createTask(task);
  const status = await deps.chat.send(channelId, await renderTaskStatus(deps, task));
  await deps.chat.pin(status).catch((error) => {
    console.warn(`Could not pin task status in channel ${channelId}:`, error);
  });
  const withStatus =
    (await deps.store.updateTask(channelId, {
      statusMessageId: status.id,
    })) ?? task;

  let provisioningError: string | undefined;
  try {
    await queue.runExclusive(channelId, async () => {
      const { sandbox } = await manager.getOrCreate({
        task: withStatus,
        guildName: command.guildName,
      });
      const ready = await deps.store.updateTask(channelId, {
        sandboxId: sandbox.id,
        configHash: deps.config.configHash,
        status: "ready",
      });
      if (ready) await updateStatusMessage(deps, ready);
    });
  } catch (error) {
    provisioningError = sanitizeError(error, [
      deps.config.githubToken ?? "",
      ...Object.values(deps.config.sandboxEnv),
    ]);
    const current = await deps.store.getTask(channelId);
    if (current) {
      await deps.chat
        .edit(status, `${await renderTaskStatus(deps, current)}\n**Provisioning error:** ${provisioningError}`)
        .catch(() => undefined);
    }
  }
  return {
    channelId,
    task: (await deps.store.getTask(channelId)) ?? withStatus,
    provisioningError,
  };
}

export async function closeTask(
  deps: Deps,
  manager: SandboxManager,
  channelId: string,
): Promise<void> {
  const task = await deps.store.getTask(channelId);
  if (!task) throw new Error("No task is associated with this channel.");
  await manager.destroy(channelId, task.sandboxId);
  await deps.store.clearSessionsForChannel(channelId);
  const archived = await deps.store.updateTask(channelId, {
    status: "archived",
    sandboxId: null,
  });
  if (archived) await updateStatusMessage(deps, archived);
  await deps.chat.archiveThreads(channelId);
}

export async function updateStatusMessage(
  deps: Deps,
  task: TaskRecord,
): Promise<void> {
  if (!task.statusMessageId) return;
  await deps.chat
    .edit(
      { id: task.statusMessageId, channelId: task.channelId },
      await renderTaskStatus(deps, task),
    )
    .catch((error) => {
      console.warn(
        `Could not refresh task status for channel ${task.channelId}:`,
        error,
      );
    });
}

export async function renderTaskStatus(
  deps: Pick<Deps, "store" | "clock">,
  task: TaskRecord,
): Promise<string> {
  const sessions = (await deps.store.listSessionsForChannel(task.channelId)).length;
  const reference =
    task.refNumber === null
      ? `https://github.com/${task.repo}`
      : `https://github.com/${task.repo}/${task.kind === "review" ? "pull" : "issues"}/${task.refNumber}`;
  return [
    `**Task:** ${task.repo}${task.refNumber === null ? "" : ` #${task.refNumber}`} — ${reference}`,
    `**Kind:** ${task.kind}  **Branch:** \`${task.branch.replaceAll("`", "'")}\``,
    `**Model:** ${task.model ? `\`${task.model.replaceAll("`", "'")}\`` : "server default"}`,
    `**Status:** ${task.status}  **Sandbox:** \`${task.sandboxId ?? "none"}\``,
    `**Sessions/threads:** ${sessions}`,
    `**Last updated:** <t:${Math.floor((deps.clock ?? Date.now)() / 1_000)}:R>`,
  ].join("\n");
}

export function parseRepoFullName(value: string): RepoReference | undefined {
  const match = value.trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  return match ? { owner: match[1]!, name: match[2]! } : undefined;
}

export function findGitHubReference(
  content: string,
): GitHubReference | undefined {
  for (const match of content.match(
    /https:\/\/github\.com\/[^\s<>()]+?\/(?:issues|pull)\/[1-9]\d*/gi,
  ) ?? []) {
    try {
      const url = new URL(match);
      const parts = url.pathname.match(
        /^\/([^/]+)\/([^/]+)\/(issues|pull)\/([1-9]\d*)\/?$/,
      );
      if (parts) {
        return {
          owner: parts[1]!,
          name: parts[2]!,
          urlKind: parts[3] === "pull" ? "pull" : "issue",
          number: Number(parts[4]),
        };
      }
    } catch {
      // Ignore malformed URLs.
    }
  }
  return undefined;
}

function inferBranch(options: {
  kind: TaskKind;
  number: number;
  slug: string;
  explicitBranch?: string;
  metadata: GitHubMetadata;
}): string {
  if (options.explicitBranch) return options.explicitBranch;
  if (options.kind === "feature") {
    return `feat/${options.number}-${options.slug}`;
  }
  if (options.kind === "review" && options.metadata.headRef) {
    return options.metadata.headRef;
  }
  return options.metadata.defaultBranch ?? "main";
}

function referenceContext(
  ref: GitHubReference,
  kind: TaskKind,
  branch: string,
  metadata: GitHubMetadata,
): string {
  const repo = `${ref.owner}/${ref.name}`;
  const label = ref.urlKind === "pull" ? "Pull request" : "Issue";
  const body = metadata.body?.trim();
  return [
    "Task context (provided automatically; you do not need to ask for it):",
    `- ${label}: ${repo}#${ref.number}${metadata.title ? ` — ${metadata.title}` : ""}`,
    `- URL: https://github.com/${repo}/${ref.urlKind === "pull" ? "pull" : "issues"}/${ref.number}`,
    `- Kind: ${kind}`,
    `- Branch: ${branch}`,
    body ? `\n${label} description:\n${truncateContext(body)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function repoContext(
  repo: string,
  kind: TaskKind,
  branch: string,
  prompt?: string,
): string {
  return [
    "Task context (provided automatically; you do not need to ask for it):",
    `- Repository: ${repo}`,
    `- Kind: ${kind}`,
    `- Branch: ${branch}`,
    prompt?.trim() ? `\nOriginal request:\n${truncateContext(prompt.trim())}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function truncateContext(value: string): string {
  return value.length <= 4_000
    ? value
    : `${value.slice(0, 4_000)}\n… (truncated)`;
}

function slugify(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function createChannelName(
  kind: TaskKind,
  refNumber: number | null,
  slug: string,
): string {
  return [kind, refNumber, slug].filter((part) => part !== null).join("-").slice(0, 100);
}
