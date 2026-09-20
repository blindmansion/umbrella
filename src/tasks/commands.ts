import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type TextChannel,
} from "discord.js";
import type { SandboxNetworkIsolation } from "railway";
import {
  destroySandbox,
  getExistingSandbox,
  getOrCreateSandbox,
} from "../sandbox/manager";
import { runExclusive } from "../sandbox/queue";
import { clearModelCache, getAvailableModels } from "../opencode/models";
import {
  clearSessionsForChannel,
  createTask,
  getGuildRepo,
  getSession,
  getTask,
  listSessionsForChannel,
  setGuildRepo,
  clearGuildRepo,
  updateSessionModel,
  updateTask,
  type TaskKind,
  type TaskRecord,
} from "../store";
import type { SandboxTracing } from "../tracing/phoenix";
import {
  buildReferenceContext,
  buildRepoContext,
} from "./context";
import {
  fetchGitHubMetadata,
  fetchOpenIssues,
  fetchRepoDefaultBranch,
  inferBranch,
  parseGitHubUrl,
  parseRepoFullName,
  rankIssues,
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
      .setAutocomplete(true)
      .setMaxLength(300),
  )
  .addStringOption((option) =>
    option
      .setName("repo")
      .setDescription(
        "Repository (owner/name) to use without an issue or pull request",
      )
      .setMaxLength(200),
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

const modelCommand = new SlashCommandBuilder()
  .setName("model")
  .setDescription("Show or set the OpenCode model for this session")
  .addStringOption((option) =>
    option
      .setName("model")
      .setDescription(
        "Model to use in this thread. Autocompletes from the running sandbox.",
      )
      .setAutocomplete(true)
      .setMaxLength(200),
  );

const repoCommand = new SlashCommandBuilder()
  .setName("repo")
  .setDescription("Show or set this server's default task repository")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub.setName("show").setDescription("Show the current task repository"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("set")
      .setDescription("Set the repository used for requests without an issue")
      .addStringOption((option) =>
        option
          .setName("repo")
          .setDescription("Repository in owner/name form")
          .setMaxLength(200)
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("clear")
      .setDescription("Clear this server's default task repository"),
  );

export async function registerTaskCommands(guild: Guild): Promise<void> {
  await guild.commands.set([
    taskCommand.toJSON(),
    closeCommand.toJSON(),
    repoCommand.toJSON(),
    modelCommand.toJSON(),
  ]);
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
    return;
  }
  if (interaction.commandName === "repo") {
    await handleRepoCommand(interaction);
    return;
  }
  if (interaction.commandName === "model") {
    await handleModelCommand(interaction, context);
  }
}

export async function handleTaskAutocomplete(
  interaction: AutocompleteInteraction,
  context: TaskCommandContext,
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "url") {
    await interaction.respond([]);
    return;
  }

  const repoOption = interaction.options.getString("repo")?.trim();
  let repo = repoOption ? parseRepoFullName(repoOption) : undefined;
  if (!repo && interaction.guildId) {
    const guildRepo = await getGuildRepo(interaction.guildId);
    if (guildRepo) repo = parseRepoFullName(guildRepo.repo);
  }
  if (!repo) {
    await interaction.respond([]);
    return;
  }

  const issues = await withTimeout(
    fetchOpenIssues(repo, context.githubToken),
    2_500,
    [],
  );
  const choices = rankIssues(issues, focused.value)
    .map((issue) => ({
      name: truncate(`#${issue.number} ${issue.title}`, 100),
      value: issue.url,
    }))
    .filter((choice) => choice.value.length <= 100)
    .slice(0, 25);

  await interaction.respond(choices).catch((error) => {
    console.warn(
      "Could not respond to task autocomplete:",
      sanitizeError(error, context),
    );
  });
}

export async function handleModelAutocomplete(
  interaction: AutocompleteInteraction,
  context: TaskCommandContext,
): Promise<void> {
  const channelId = taskChannelIdFor(interaction);
  const focused = interaction.options.getFocused().toLowerCase();

  const task = await getTask(channelId);
  if (!task || task.status === "archived") {
    await interaction.respond([]);
    return;
  }

  if (!task.sandboxId) {
    await interaction.respond([]);
    return;
  }

  const sandbox = await getExistingSandbox(task.channelId, task.sandboxId);
  if (!sandbox) {
    await interaction.respond([]);
    return;
  }

  const models = await withTimeout(
    getAvailableModels(task.channelId, sandbox),
    2_000,
    [],
  );
  const choices = models
    .filter(
      (model) => model.length <= 100 && model.toLowerCase().includes(focused),
    )
    .slice(0, 25)
    .map((model) => ({ name: model, value: model }));

  await interaction.respond(choices).catch((error) => {
    console.warn(
      "Could not respond to model autocomplete:",
      sanitizeError(error, context),
    );
  });
}

async function handleModelCommand(
  interaction: ChatInputCommandInteraction,
  context: TaskCommandContext,
): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: "`/model` can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  const requested = interaction.options.getString("model")?.trim();

  const channel = interaction.channel;
  if (!channel) {
    await interaction.reply({
      content: "`/model` must be used inside an active task channel or thread.",
      ephemeral: true,
    });
    return;
  }
  if (channel.isThread()) {
    const session = await getSession(channel.id);
    if (!session) {
      await interaction.reply({
        content:
          "This thread isn't a bot session. Start one from the task channel first.",
        ephemeral: true,
      });
      return;
    }
    if (!requested) {
      await interaction.reply(
        session.model
          ? `This session uses \`${session.model}\`.`
          : "This session uses the server default. Pass a `model` option to choose one.",
      );
      return;
    }
    const model = sanitizeModel(requested);
    if (!model) {
      await interaction.reply({
        content: "That model name isn't valid.",
        ephemeral: true,
      });
      return;
    }
    await updateSessionModel(channel.id, model);
    clearModelCache(session.channelId);
    await interaction.reply(
      `This session will use \`${model}\` for subsequent prompts.`,
    );
    return;
  }

  const task = await getTask(channel.id);
  if (!task || task.status === "archived") {
    await interaction.reply({
      content:
        "`/model` must be used inside an active task channel or one of its threads.",
      ephemeral: true,
    });
    return;
  }

  if (!requested) {
    await interaction.reply(
      task.model
        ? `This task uses \`${task.model}\`. New threads inherit it.`
        : "This task uses the server default. Pass a `model` option to choose one for new threads.",
    );
    return;
  }

  const model = sanitizeModel(requested);
  if (!model) {
    await interaction.reply({
      content: "That model name isn't valid.",
      ephemeral: true,
    });
    return;
  }
  const updated = await updateTask(task.channelId, { model });
  if (updated) await updateStatusMessage(context.client, updated);
  const taskChannelId = taskChannelIdFor(interaction);
  clearModelCache(taskChannelId);
  await interaction.reply(
    `New sessions in this task will use \`${model}\`. Threads with their own model keep it.`,
  );
}

function taskChannelIdFor(
  interaction: ChatInputCommandInteraction | AutocompleteInteraction,
): string {
  const channel = interaction.channel;
  if (channel?.isThread()) {
    return channel.parentId ?? channel.id;
  }
  return interaction.channelId;
}

function sanitizeModel(value: string): string | undefined {
  const model = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!model || /\s/.test(model) || model.length > 200) return undefined;
  return model;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
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

  const url = interaction.options.getString("url")?.trim();
  const repoOption = interaction.options.getString("repo")?.trim();
  const requestedKind = interaction.options.getString("kind") as
    | TaskKind
    | null;
  const explicitBranch = interaction.options.getString("branch")?.trim();

  const reference = url ? parseGitHubUrl(url) : undefined;
  if (url && !reference) {
    await interaction.reply({
      content:
        "Use a GitHub issue or pull request URL like `https://github.com/owner/repo/issues/123` or `/pull/123`.",
      ephemeral: true,
    });
    return;
  }
  if (repoOption && !parseRepoFullName(repoOption)) {
    await interaction.reply({
      content: "The `repo` option must be in `owner/name` form.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  try {
    if (reference) {
      const kind =
        requestedKind ?? (reference.urlKind === "pull" ? "review" : "feature");
      const { channel, provisioningError } =
        await createTaskChannelFromReference({
          guild: interaction.guild,
          actorTag: interaction.user.tag,
          reference,
          kind,
          explicitBranch,
          context,
        });
      await interaction.editReply(
        provisioningError
          ? `Task channel created at ${channel}, but sandbox provisioning failed: ${provisioningError}`
          : `Task ready: ${channel}`,
      );
      return;
    }

    const repo =
      repoOption ?? (await getGuildRepo(interaction.guild.id))?.repo;
    if (!repo) {
      await interaction.editReply(
        "This server doesn't have a task repository yet. Set one with `/repo set owner/name`, pass the `repo` option, or share a GitHub issue or pull request URL.",
      );
      return;
    }

    const { channel, provisioningError } = await createTaskChannelForRepo({
      guild: interaction.guild,
      actorTag: interaction.user.tag,
      repo,
      kind: requestedKind ?? "planning",
      explicitBranch,
      context,
    });
    await interaction.editReply(
      provisioningError
        ? `Task channel created at ${channel}, but sandbox provisioning failed: ${provisioningError}`
        : `Task ready: ${channel}`,
    );
  } catch (error) {
    await interaction.editReply(
      `Could not create the task: ${sanitizeError(error, context)}`,
    );
  }
}

async function handleRepoCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: "`/repo` can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "set") {
    const value = interaction.options.getString("repo", true).trim();
    const parsed = parseRepoFullName(value);
    if (!parsed) {
      await interaction.reply({
        content: "Use `owner/name`, for example `/repo set blindmansion/umbrella`.",
        ephemeral: true,
      });
      return;
    }
    const repo = `${parsed.owner}/${parsed.name}`;
    await setGuildRepo(interaction.guild.id, repo);
    await interaction.reply(
      `This server's task repository is now \`${repo}\`. Requests without a GitHub issue or pull request will run against it.`,
    );
    return;
  }

  if (subcommand === "clear") {
    await clearGuildRepo(interaction.guild.id);
    await interaction.reply("This server's task repository has been cleared.");
    return;
  }

  const current = await getGuildRepo(interaction.guild.id);
  await interaction.reply(
    current
      ? `This server's task repository is \`${current.repo}\`.`
      : "No task repository is set. An admin can set one with `/repo set owner/name`.",
  );
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

  return provisionTaskChannel({
    guild,
    actorTag,
    context,
    resolved: {
      kind,
      repo: `${reference.owner}/${reference.name}`,
      refNumber: reference.number,
      branch,
      slug,
      context: buildReferenceContext({
        kind,
        repo: `${reference.owner}/${reference.name}`,
        refNumber: reference.number,
        branch,
        reference,
        metadata,
      }),
    },
  });
}

export async function createTaskChannelForRepo(options: {
  guild: Guild;
  actorTag: string;
  repo: string;
  kind?: TaskKind;
  prompt?: string;
  explicitBranch?: string;
  context: TaskCommandContext;
}): Promise<TaskProvisionResult> {
  const { guild, actorTag, repo: repoInput, prompt, explicitBranch, context } =
    options;
  const parsed = parseRepoFullName(repoInput);
  if (!parsed) {
    throw new Error(`"${repoInput}" is not a valid owner/name repository.`);
  }

  const defaultBranch = await fetchRepoDefaultBranch(
    parsed,
    context.githubToken,
  );
  const title = prompt?.trim() || "task";
  const slug = slugify(title) || "task";
  const kind = options.kind ?? "planning";
  const branch = explicitBranch ?? defaultBranch ?? "main";
  const repo = `${parsed.owner}/${parsed.name}`;

  return provisionTaskChannel({
    guild,
    actorTag,
    context,
    resolved: {
      kind,
      repo,
      refNumber: null,
      branch,
      slug,
      context: buildRepoContext({ kind, repo, branch, request: prompt }),
    },
  });
}

async function provisionTaskChannel(options: {
  guild: Guild;
  actorTag: string;
  resolved: {
    kind: TaskKind;
    repo: string;
    refNumber: number | null;
    branch: string;
    slug: string;
    context?: string | null;
  };
  context: TaskCommandContext;
}): Promise<TaskProvisionResult> {
  const { guild, actorTag, resolved, context } = options;
  const { kind, repo, refNumber, branch, slug, context: taskContext } = resolved;

  const [owner, name] = repo.split("/");
  const category = await findOrCreateRepoCategory(guild, owner!, name!);
  const channel = await guild.channels.create({
    name: createChannelName(kind, refNumber, slug),
    type: ChannelType.GuildText,
    parent: category.id,
    reason: `Task created by ${actorTag}`,
  });

  const task: TaskRecord = {
    channelId: channel.id,
    kind,
    repo,
    refNumber,
    branch,
    sandboxId: null,
    status: "provisioning",
    configHash: null,
    statusMessageId: null,
    model: null,
    context: taskContext ?? null,
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
        guildName: guild.name,
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
    `**Model:** ${task.model ? `\`${task.model.replaceAll("`", "'")}\`` : "server default"}`,
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
