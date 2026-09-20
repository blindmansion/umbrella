import {
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Guild,
} from "discord.js";
import type {
  Command,
  GitHubClient,
  StateStore,
  TaskKind,
} from "../../core/ports";
import { parseRepoFullName } from "../../core/provision";
import {
  buildIssueUrl,
  parseGitHubUrl,
  rankIssues,
} from "../../tasks/github";
import { truncate } from "../../core/utils";

type Runtime = {
  onCommand(command: Command): Promise<{ ok: boolean; message: string }>;
  getAvailableModels(channelId: string): Promise<string[]>;
};

const definitions = [
  new SlashCommandBuilder()
    .setName("task")
    .setDescription("Create a task channel and Railway sandbox")
    .addStringOption((option) =>
      option.setName("url").setDescription("GitHub issue or pull request URL").setAutocomplete(true),
    )
    .addStringOption((option) =>
      option.setName("repo").setDescription("Repository in owner/name form"),
    )
    .addStringOption((option) =>
      option
        .setName("kind")
        .setDescription("Task type")
        .addChoices(
          { name: "planning", value: "planning" },
          { name: "feature", value: "feature" },
          { name: "bugfix", value: "bugfix" },
          { name: "review", value: "review" },
        ),
    )
    .addStringOption((option) =>
      option.setName("branch").setDescription("Explicit git branch"),
    ),
  new SlashCommandBuilder()
    .setName("close")
    .setDescription("Archive this task and destroy its sandbox"),
  new SlashCommandBuilder()
    .setName("model")
    .setDescription("Show or set the OpenCode model")
    .addStringOption((option) =>
      option.setName("model").setDescription("OpenCode model").setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName("repo")
    .setDescription("Show or set this server's default task repository")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) => sub.setName("show").setDescription("Show the repository"))
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Set the repository")
        .addStringOption((option) =>
          option.setName("repo").setDescription("owner/name").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("clear").setDescription("Clear the repository"),
    ),
];

export async function registerCommands(guild: Guild): Promise<void> {
  await guild.commands.set(definitions.map((definition) => definition.toJSON()));
}

export async function handleCommand(
  interaction: ChatInputCommandInteraction,
  runtime: Runtime,
): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
    return;
  }
  let command: Command;
  if (interaction.commandName === "task") {
    const url = interaction.options.getString("url")?.trim();
    const reference = url ? parseGitHubUrl(url) : undefined;
    if (url && !reference) {
      await interaction.reply({ content: "Use a GitHub issue or pull request URL.", ephemeral: true });
      return;
    }
    const repo = interaction.options.getString("repo")?.trim();
    if (repo && !parseRepoFullName(repo)) {
      await interaction.reply({ content: "The repository must be in `owner/name` form.", ephemeral: true });
      return;
    }
    command = {
      type: "task",
      guildId: interaction.guild.id,
      guildName: interaction.guild.name,
      actorId: interaction.user.id,
      actorName: interaction.user.tag,
      reference,
      repo,
      kind: (interaction.options.getString("kind") as TaskKind | null) ?? undefined,
      branch: interaction.options.getString("branch")?.trim(),
    };
  } else if (interaction.commandName === "close") {
    const channelId = interaction.channel?.isThread()
      ? interaction.channel.parentId
      : interaction.channelId;
    if (!channelId) {
      await interaction.reply({ content: "`/close` must be used in a task channel.", ephemeral: true });
      return;
    }
    command = { type: "close", channelId };
  } else if (interaction.commandName === "model") {
    const threadId = interaction.channel?.isThread()
      ? interaction.channel.id
      : undefined;
    command = {
      type: "model",
      channelId: interaction.channel?.isThread()
        ? interaction.channel.parentId ?? interaction.channel.id
        : interaction.channelId,
      threadId,
      model: interaction.options.getString("model")?.trim(),
    };
  } else {
    const action = interaction.options.getSubcommand() as "show" | "set" | "clear";
    command = {
      type: "repo",
      guildId: interaction.guild.id,
      action,
      repo: action === "set" ? interaction.options.getString("repo", true) : undefined,
    };
  }
  await interaction.deferReply();
  const result = await runtime.onCommand(command);
  await interaction.editReply(result.message);
}

export async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  runtime: Runtime,
  store: StateStore,
  github: GitHubClient,
): Promise<void> {
  if (interaction.commandName === "model") {
    const channelId = interaction.channel?.isThread()
      ? interaction.channel.parentId ?? interaction.channel.id
      : interaction.channelId;
    const query = interaction.options.getFocused().toLowerCase();
    const models = await withTimeout(
      runtime.getAvailableModels(channelId),
      2_000,
      [],
    );
    await interaction.respond(
      models
        .filter((model) => model.toLowerCase().includes(query))
        .slice(0, 25)
        .map((model) => ({ name: model, value: model })),
    );
    return;
  }
  const focused = interaction.options.getFocused(true);
  if (interaction.commandName !== "task" || focused.name !== "url") {
    await interaction.respond([]);
    return;
  }
  const configured =
    interaction.options.getString("repo")?.trim() ||
    (interaction.guildId
      ? (await store.getGuildRepo(interaction.guildId))?.repo
      : undefined);
  const repo = configured ? parseRepoFullName(configured) : undefined;
  if (!repo) {
    await interaction.respond([]);
    return;
  }
  const issues = await withTimeout(github.fetchOpenIssues(repo), 2_500, []);
  await interaction.respond(
    rankIssues(issues, focused.value)
      .map((issue) => ({
        name: truncate(`#${issue.number} ${issue.title}`, 100),
        value: issue.url || buildIssueUrl(repo, issue.number),
      }))
      .filter((choice) => choice.value.length <= 100)
      .slice(0, 25),
  );
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
