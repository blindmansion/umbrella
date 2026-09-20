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
  GitHubClient,
  IncomingMessage,
  StateStore,
} from "../../core/ports";
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
};

export async function startBot(options: {
  token: string;
  store: StateStore;
  github: GitHubClient;
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
    isReplyToBot: message.reference?.messageId !== undefined,
  };
}
