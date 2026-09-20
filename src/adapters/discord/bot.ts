import {
  Client,
  Events,
  GatewayIntentBits,
  OAuth2Scopes,
  PermissionFlagsBits,
  type Message,
} from "discord.js";
import type {
  Command,
  CommandResult,
  CoreConfig,
  GitHubClient,
  IncomingMessage,
  StateStore,
} from "../../core/ports";
import { scheduleMaintenance } from "../../core/scheduler";
import { DiscordChatPlatform } from "./chat";
import {
  handleAutocomplete,
  handleCommand,
  registerCommands,
} from "./commands";

type Runtime = {
  onMessage(message: IncomingMessage): Promise<void>;
  onCommand(command: Command): Promise<CommandResult>;
  getAvailableModels(channelId: string): Promise<string[]>;
  runMaintenance?(): Promise<unknown>;
};

export async function startBot(options: {
  token: string;
  store: StateStore;
  github: GitHubClient;
  config: CoreConfig & {
    intent?: { model: string; confidenceThreshold: number };
    reconcileIntervalMinutes?: number;
  };
  createRuntime(chat: DiscordChatPlatform): Runtime;
}): Promise<Client> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  const chat = new DiscordChatPlatform(client);
  const runtime = options.createRuntime(chat);

  client.once(Events.ClientReady, async (ready) => {
    console.log(`Discord bot logged in as ${ready.user.tag}`);
    if (options.config.tracing) {
      console.log(
        `OpenCode tracing enabled: sandboxes will export to ${options.config.tracing.endpoint} (networkIsolation=${options.config.networkIsolation ?? "ISOLATED"}).`,
      );
    } else {
      console.log(
        "OpenCode tracing disabled. Set PHOENIX_ENDPOINT to a Phoenix URL reachable from Railway sandboxes to enable it.",
      );
    }
    if (options.config.intent) {
      console.log(
        `Intent classification enabled via TypeSafe ${options.config.intent.model} (confidence threshold=${options.config.intent.confidenceThreshold}).`,
      );
    } else {
      console.log(
        "Intent classification disabled. Set TYPESAFE_API_KEY to let the bot infer intent without mentions.",
      );
    }
    await Promise.all(
      ready.guilds.cache.map((guild) =>
        registerCommands(guild).catch((error) => {
          console.error(`Could not register commands for guild ${guild.id}:`, error);
        }),
      ),
    );
    console.log(
      `Invite it to a server: ${ready.generateInvite({
        scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands],
        permissions: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.CreatePublicThreads,
          PermissionFlagsBits.SendMessagesInThreads,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ManageMessages,
        ],
      })}`,
    );
    const intervalMinutes = options.config.reconcileIntervalMinutes ?? 0;
    if (intervalMinutes > 0 && runtime.runMaintenance) {
      const maintenance = scheduleMaintenance({
        intervalMs: intervalMinutes * 60_000,
        run: runtime.runMaintenance,
        onError: (error) =>
          console.error("Task maintenance pass failed:", error),
      });
      console.log(
        `Task maintenance enabled: checking for closed issue references every ${intervalMinutes} minute(s).`,
      );
      void maintenance.runNow();
    }
  });

  client.on(Events.GuildCreate, (guild) => {
    void registerCommands(guild).catch(console.error);
  });
  client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.isAutocomplete()) {
      void handleAutocomplete(
        interaction,
        runtime,
        options.store,
        options.github,
      ).catch(async (error) => {
        console.error("Could not handle autocomplete:", error);
        await interaction.respond([]).catch(() => undefined);
      });
    } else if (interaction.isChatInputCommand()) {
      void handleCommand(interaction, runtime).catch(async (error) => {
        console.error("Could not handle command:", error);
        const response = {
          content: "The command failed unexpectedly. Check the bot logs for details.",
          ephemeral: true,
        } as const;
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp(response).catch(() => undefined);
        } else {
          await interaction.reply(response).catch(() => undefined);
        }
      });
    }
  });
  client.on(Events.MessageCreate, (message) => {
    const incoming = toIncomingMessage(client.user?.id, message);
    if (incoming) {
      void runtime.onMessage(incoming).catch((error) => {
        console.error("Could not route Discord message:", error);
      });
    }
  });
  client.on(Events.Error, (error) => console.error("Discord client error:", error));

  await client.login(options.token);
  return client;
}

function toIncomingMessage(
  botId: string | undefined,
  message: Message,
): IncomingMessage | undefined {
  if (!botId || message.author.bot || !message.inGuild()) return undefined;
  const botMentioned = message.mentions.users.has(botId);
  let text = message.content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
  for (const [id, user] of message.mentions.users) {
    text = text.replace(new RegExp(`<@!?${id}>`, "g"), `@${user.username}`);
  }
  return {
    id: message.id,
    guildId: message.guild.id,
    guildName: message.guild.name,
    channelId: message.channel.isThread()
      ? message.channel.parentId ?? message.channel.id
      : message.channel.id,
    threadId: message.channel.isThread() ? message.channel.id : undefined,
    authorId: message.author.id,
    authorName: message.author.username,
    text,
    botMentioned,
  };
}
