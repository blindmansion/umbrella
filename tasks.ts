import {
  ChannelType,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
} from "discord.js";
import {
  destroySandbox,
  getOrCreateSandbox,
  runExclusive,
} from "./sandboxes";
import {
  clearSessionsForChannel,
  createTask,
  getTask,
  listSessionsForChannel,
  updateTask,
  type TaskKind,
  type TaskRecord,
} from "./store";

export type TaskCommandContext = {
  client: Client;
  sandboxEnv: Record<string, string>;
  configHash: string;
  githubToken?: string;
};

type GitHubReference = {
  owner: string;
  name: string;
  number: number;
  urlKind: "issue" | "pull";
};

type GitHubMetadata = {
  title?: string;
  headRef?: string;
  defaultBranch?: string;
};

const taskCommand = new SlashCommandBuilder()
  .setName("task")
  .setDescription("Create a task channel and Railway sandbox")
  .addStringOption((option) =>
    option
      .setName("url")
      .setDescription("GitHub issue or pull request URL")
      .setMaxLength(300)
      .setRequired(true),
  )
  .addStringOption((option) =>
    option
      .setName("kind")
      .setDescription("Task type (inferred from the URL by default)")
      .addChoices(
        { name: "planning", value: "planning" },
        { name: "feature", value: "feature" },
        { name: "bugfix", value: "bugfix" },
        { name: "review", value: "review" },
      ),
  )
  .addStringOption((option) =>
    option
      .setName("branch")
      .setDescription("Explicit git branch")
      .setMaxLength(255),
  );

const closeCommand = new SlashCommandBuilder()
  .setName("close")
  .setDescription("Archive this task and destroy its sandbox");

export async function registerTaskCommands(guild: Guild): Promise<void> {
  await guild.commands.set([taskCommand.toJSON(), closeCommand.toJSON()]);
}

export async function handleTaskInteraction(
  interaction: ChatInputCommandInteraction,
  context: TaskCommandContext,
): Promise<void> {
  if (interaction.commandName === "task") {
    await createTaskChannel(interaction, context);
    return;
  }
  if (interaction.commandName === "close") {
    await closeTaskChannel(interaction, context.client);
  }
}

export async function updateStatusMessage(
  client: Client,
  task: TaskRecord,
): Promise<void> {
  if (!task.statusMessageId) return;

  try {
    const channel = await client.channels.fetch(task.channelId);
    if (!channel?.isTextBased() || !("messages" in channel)) return;
    const message = await channel.messages.fetch(task.statusMessageId);
    await message.edit(await renderTaskStatus(task));
  } catch (error) {
    console.warn(
      `Could not refresh task status for channel ${task.channelId}:`,
      sanitizeError(error),
    );
  }
}

async function createTaskChannel(
  interaction: ChatInputCommandInteraction,
  context: TaskCommandContext,
): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: "`/task` can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  const url = interaction.options.getString("url", true);
  const reference = parseGitHubUrl(url);
  if (!reference) {
    await interaction.reply({
      content:
        "Use a GitHub issue or pull request URL like `https://github.com/owner/repo/issues/123` or `/pull/123`.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  const requestedKind = interaction.options.getString("kind") as
    | TaskKind
    | null;
  const kind =
    requestedKind ?? (reference.urlKind === "pull" ? "review" : "feature");
  const explicitBranch = interaction.options.getString("branch")?.trim();
  const metadata = await fetchGitHubMetadata(reference, context.githubToken);

  if (kind === "review" && !metadata.headRef && !explicitBranch) {
    await interaction.editReply(
      "I couldn't fetch this pull request's head branch. Re-run `/task` with the `branch` option.",
    );
    return;
  }

  const title =
    metadata.title ??
    `${reference.urlKind === "pull" ? "pull" : "issue"}-${reference.number}`;
  const slug = slugify(title) || `${reference.urlKind}-${reference.number}`;
  const branch = inferBranch({
    kind,
    number: reference.number,
    slug,
    explicitBranch,
    metadata,
  });
  const repo = `${reference.owner}/${reference.name}`;

  try {
    const category = await findOrCreateRepoCategory(
      interaction.guild,
      reference.owner,
      reference.name,
    );
    const channel = await interaction.guild.channels.create({
      name: createChannelName(kind, reference.number, slug),
      type: ChannelType.GuildText,
      parent: category.id,
      reason: `Task created by ${interaction.user.tag}`,
    });

    const task: TaskRecord = {
      channelId: channel.id,
      kind,
      repo,
      refNumber: reference.number,
      branch,
      sandboxId: null,
      status: "provisioning",
      configHash: null,
      statusMessageId: null,
      createdAt: Date.now(),
    };
    await createTask(task);

    const statusMessage = await channel.send(await renderTaskStatus(task));
    await statusMessage.pin("Task status").catch((error) => {
      console.warn(
        `Could not pin task status in channel ${channel.id}:`,
        sanitizeError(error),
      );
    });
    const taskWithMessage =
      (await updateTask(channel.id, {
        statusMessageId: statusMessage.id,
      })) ?? task;

    try {
      await runExclusive(channel.id, async () => {
        const { sandbox } = await getOrCreateSandbox({
          task: taskWithMessage,
          sandboxEnv: context.sandboxEnv,
          configHash: context.configHash,
          githubToken: context.githubToken,
        });
        const readyTask = await updateTask(channel.id, {
          sandboxId: sandbox.id,
          configHash: context.configHash,
          status: "ready",
        });
        if (readyTask) await updateStatusMessage(context.client, readyTask);
      });
      await interaction.editReply(`Task ready: ${channel}`);
    } catch (error) {
      const detail = sanitizeError(error, context);
      const currentTask = await getTask(channel.id);
      if (currentTask) {
        await statusMessage
          .edit(
            `${await renderTaskStatus(currentTask)}\n**Provisioning error:** ${detail}`,
          )
          .catch((editError) => {
            console.warn(
              `Could not show provisioning failure in channel ${channel.id}:`,
              sanitizeError(editError),
            );
          });
      }
      await interaction.editReply(
        `Task channel created at ${channel}, but sandbox provisioning failed: ${detail}`,
      );
    }
  } catch (error) {
    await interaction.editReply(
      `Could not create the task: ${sanitizeError(error, context)}`,
    );
  }
}

async function closeTaskChannel(
  interaction: ChatInputCommandInteraction,
  client: Client,
): Promise<void> {
  const task = interaction.channelId
    ? await getTask(interaction.channelId)
    : undefined;
  if (!task) {
    await interaction.reply({
      content: "`/close` must be used inside a task channel.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();
  try {
    await destroySandbox(task.channelId, task.sandboxId ?? undefined);
    await clearSessionsForChannel(task.channelId);
    const archivedTask = await updateTask(task.channelId, {
      status: "archived",
      sandboxId: null,
    });
    if (archivedTask) await updateStatusMessage(client, archivedTask);

    const channel = interaction.channel;
    if (channel?.type === ChannelType.GuildText) {
      const activeThreads = await channel.threads.fetchActive().catch((error) => {
        console.warn(
          `Could not fetch active threads for channel ${task.channelId}:`,
          sanitizeError(error),
        );
        return undefined;
      });
      if (activeThreads) {
        await Promise.allSettled(
          activeThreads.threads.map((thread) =>
            thread.setArchived(true, "Task closed"),
          ),
        );
      }
    }

    await interaction.editReply(
      "Task archived and its sandbox destroyed. Channel history has been preserved.",
    );
  } catch (error) {
    await interaction.editReply(
      `Could not close the task: ${sanitizeError(error)}`,
    );
  }
}

function parseGitHubUrl(value: string): GitHubReference | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    return undefined;
  }

  const match = url.pathname.match(
    /^\/([^/]+)\/([^/]+)\/(issues|pull)\/([1-9]\d*)\/?$/,
  );
  if (!match) return undefined;
  return {
    owner: match[1]!,
    name: match[2]!,
    urlKind: match[3] === "pull" ? "pull" : "issue",
    number: Number(match[4]),
  };
}

async function fetchGitHubMetadata(
  reference: GitHubReference,
  githubToken?: string,
): Promise<GitHubMetadata> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "railway-opencode-discord-bot",
  };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

  const base = `https://api.github.com/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.name)}`;
  const metadata: GitHubMetadata = {};
  const detailPath =
    reference.urlKind === "pull"
      ? `pulls/${reference.number}`
      : `issues/${reference.number}`;

  const [detailResult, repoResult] = await Promise.allSettled([
    fetch(`${base}/${detailPath}`, { headers }),
    fetch(base, { headers }),
  ]);

  if (detailResult.status === "fulfilled" && detailResult.value.ok) {
    try {
      const detail = (await detailResult.value.json()) as {
        title?: unknown;
        head?: { ref?: unknown };
      };
      if (typeof detail.title === "string") metadata.title = detail.title;
      if (typeof detail.head?.ref === "string") metadata.headRef = detail.head.ref;
    } catch {
      // Fall back to URL-derived metadata.
    }
  }
  if (repoResult.status === "fulfilled" && repoResult.value.ok) {
    try {
      const repo = (await repoResult.value.json()) as {
        default_branch?: unknown;
      };
      if (typeof repo.default_branch === "string") {
        metadata.defaultBranch = repo.default_branch;
      }
    } catch {
      // Fall back to "main".
    }
  }

  return metadata;
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

async function findOrCreateRepoCategory(
  guild: Guild,
  owner: string,
  name: string,
) {
  const categoryName = slugify(`${owner}-${name}`).slice(0, 100) || "tasks";
  const channels = await guild.channels.fetch();
  const existing = channels.find(
    (channel) =>
      channel?.type === ChannelType.GuildCategory &&
      channel.name.toLowerCase() === categoryName,
  );
  if (existing?.type === ChannelType.GuildCategory) return existing;
  return guild.channels.create({
    name: categoryName,
    type: ChannelType.GuildCategory,
    reason: `Task category for ${owner}/${name}`,
  });
}

function createChannelName(
  kind: TaskKind,
  number: number | null,
  slug: string,
): string {
  const prefixes: Record<TaskKind, string> = {
    planning: "plan",
    feature: "feat",
    bugfix: "bug",
    review: "pr",
  };
  const stem = `${prefixes[kind]}${number === null ? "" : `-${number}`}`;
  const maxSlugLength = Math.max(1, 60 - stem.length - 1);
  return `${stem}-${slug.slice(0, maxSlugLength)}`.slice(0, 100);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

async function renderTaskStatus(task: TaskRecord): Promise<string> {
  const sessions = (await listSessionsForChannel(task.channelId)).length;
  const reference =
    task.refNumber === null
      ? `https://github.com/${task.repo}`
      : `https://github.com/${task.repo}/${task.kind === "review" ? "pull" : "issues"}/${task.refNumber}`;
  return [
    `**Task:** ${task.repo}${task.refNumber === null ? "" : ` #${task.refNumber}`} — ${reference}`,
    `**Kind:** ${task.kind}  **Branch:** \`${task.branch.replaceAll("`", "'")}\``,
    `**Status:** ${task.status}  **Sandbox:** \`${task.sandboxId ?? "none"}\``,
    `**Sessions/threads:** ${sessions}`,
    `**Last updated:** <t:${Math.floor(Date.now() / 1_000)}:R>`,
  ].join("\n");
}

function sanitizeError(
  error: unknown,
  context?: Pick<TaskCommandContext, "githubToken" | "sandboxEnv">,
): string {
  let message = error instanceof Error ? error.message : String(error);
  const secrets = [
    context?.githubToken,
    ...Object.values(context?.sandboxEnv ?? {}),
  ].filter((secret): secret is string => Boolean(secret));
  for (const secret of secrets) {
    message = message.replaceAll(secret, "[redacted]");
    message = message.replaceAll(encodeURIComponent(secret), "[redacted]");
  }
  return message
    .replace(/https:\/\/[^@\s]+@github\.com/gi, "https://[redacted]@github.com")
    .replace(
      /(token|api[_-]?key|secret|password)(\s*[:=]\s*)\S+/gi,
      "$1$2[redacted]",
    )
    .slice(0, 1_000);
}
