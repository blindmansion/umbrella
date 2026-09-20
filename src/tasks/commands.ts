import {
  ChannelType,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type TextChannel,
} from "discord.js";
import type { SandboxNetworkIsolation } from "railway";
import {
  destroySandbox,
  getOrCreateSandbox,
} from "../sandbox/manager";
import { runExclusive } from "../sandbox/queue";
import {
  clearSessionsForChannel,
  createTask,
  getTask,
  listSessionsForChannel,
  updateTask,
  type TaskKind,
  type TaskRecord,
} from "../store";
import type { SandboxTracing } from "../tracing/phoenix";
import {
  fetchGitHubMetadata,
  inferBranch,
  parseGitHubUrl,
  type GitHubReference,
} from "./github";
import { createChannelName, slugify } from "./naming";

export type TaskCommandContext = {
  client: Client;
  sandboxEnv: Record<string, string>;
  configHash: string;
  githubToken?: string;
  tracing?: SandboxTracing;
  networkIsolation?: SandboxNetworkIsolation;
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

  try {
    const { channel, provisioningError } = await createTaskChannelFromReference({
      guild: interaction.guild,
      actorTag: interaction.user.tag,
      reference,
      kind,
      explicitBranch,
      context,
    });
    if (provisioningError) {
      await interaction.editReply(
        `Task channel created at ${channel}, but sandbox provisioning failed: ${provisioningError}`,
      );
      return;
    }
    await interaction.editReply(`Task ready: ${channel}`);
  } catch (error) {
    await interaction.editReply(
      `Could not create the task: ${sanitizeError(error, context)}`,
    );
  }
}

export type TaskProvisionResult = {
  channel: TextChannel;
  task: TaskRecord;
  provisioningError?: string;
};

export async function createTaskChannelFromReference(options: {
  guild: Guild;
  actorTag: string;
  reference: GitHubReference;
  kind: TaskKind;
  explicitBranch?: string;
  context: TaskCommandContext;
}): Promise<TaskProvisionResult> {
  const { guild, actorTag, reference, kind, explicitBranch, context } = options;
  const metadata = await fetchGitHubMetadata(reference, context.githubToken);

  if (kind === "review" && !metadata.headRef && !explicitBranch) {
    throw new Error(
      "I couldn't fetch this pull request's head branch. Provide an explicit branch.",
    );
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

  const category = await findOrCreateRepoCategory(
    guild,
    reference.owner,
    reference.name,
  );
  const channel = await guild.channels.create({
    name: createChannelName(kind, reference.number, slug),
    type: ChannelType.GuildText,
    parent: category.id,
    reason: `Task created by ${actorTag}`,
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

  let provisioningError: string | undefined;
  try {
    await runExclusive(channel.id, async () => {
      const { sandbox } = await getOrCreateSandbox({
        task: taskWithMessage,
        sandboxEnv: context.sandboxEnv,
        configHash: context.configHash,
        githubToken: context.githubToken,
        tracing: context.tracing,
        networkIsolation: context.networkIsolation,
      });
      const readyTask = await updateTask(channel.id, {
        sandboxId: sandbox.id,
        configHash: context.configHash,
        status: "ready",
      });
      if (readyTask) await updateStatusMessage(context.client, readyTask);
    });
  } catch (error) {
    provisioningError = sanitizeError(error, context);
    const currentTask = await getTask(channel.id);
    if (currentTask) {
      await statusMessage
        .edit(
          `${await renderTaskStatus(currentTask)}\n**Provisioning error:** ${provisioningError}`,
        )
        .catch((editError) => {
          console.warn(
            `Could not show provisioning failure in channel ${channel.id}:`,
            sanitizeError(editError),
          );
        });
    }
  }

  const finalTask = (await getTask(channel.id)) ?? taskWithMessage;
  return { channel, task: finalTask, provisioningError };
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
    await closeTaskWorkflow({ client, channelId: task.channelId });
    await interaction.editReply(
      "Task archived and its sandbox destroyed. Channel history has been preserved.",
    );
  } catch (error) {
    await interaction.editReply(
      `Could not close the task: ${sanitizeError(error)}`,
    );
  }
}

export async function closeTaskWorkflow(options: {
  client: Client;
  channelId: string;
}): Promise<void> {
  const { client, channelId } = options;
  const task = await getTask(channelId);
  if (!task) {
    throw new Error("No task is associated with this channel.");
  }

  await destroySandbox(channelId, task.sandboxId ?? undefined);
  await clearSessionsForChannel(channelId);
  const archivedTask = await updateTask(channelId, {
    status: "archived",
    sandboxId: null,
  });
  if (archivedTask) await updateStatusMessage(client, archivedTask);

  const channel = await client.channels.fetch(channelId).catch((error) => {
    console.warn(
      `Could not fetch task channel ${channelId} while closing:`,
      sanitizeError(error),
    );
    return undefined;
  });
  if (channel?.type === ChannelType.GuildText) {
    const activeThreads = await channel.threads.fetchActive().catch((error) => {
      console.warn(
        `Could not fetch active threads for channel ${channelId}:`,
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
