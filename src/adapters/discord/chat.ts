import {
  ChannelType,
  type Client,
  type Guild,
  type Message,
  type TextChannel,
} from "discord.js";
import type {
  ChatPlatform,
  ConversationTurn,
  IncomingMessage,
  MessageRef,
} from "../../core/ports";

export class DiscordChatPlatform implements ChatPlatform {
  constructor(private readonly client: Client) {}

  async reply(to: IncomingMessage, text: string): Promise<MessageRef> {
    const channel = await this.client.channels.fetch(to.threadId ?? to.channelId);
    if (channel?.isTextBased() && "messages" in channel) {
      const original = await channel.messages.fetch(to.id).catch(() => undefined);
      if (original) {
        const sent = await original.reply(text);
        return { id: sent.id, channelId: sent.channel.id };
      }
    }
    return this.send(to.threadId ?? to.channelId, text);
  }

  async send(channelId: string, text: string): Promise<MessageRef> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isSendable()) throw new Error(`Channel ${channelId} is not sendable`);
    const sent = await channel.send(text);
    return { id: sent.id, channelId: sent.channel.id };
  }

  async edit(ref: MessageRef, text: string): Promise<void> {
    const channel = await this.client.channels.fetch(ref.channelId);
    if (!channel?.isTextBased() || !("messages" in channel)) return;
    const message = await channel.messages.fetch(ref.id);
    await message.edit(text);
  }

  async pin(ref: MessageRef): Promise<void> {
    const channel = await this.client.channels.fetch(ref.channelId);
    if (!channel?.isTextBased() || !("messages" in channel)) return;
    await (await channel.messages.fetch(ref.id)).pin("Task status");
  }

  async startThread(from: IncomingMessage, name: string): Promise<string> {
    const channel = await this.client.channels.fetch(from.channelId);
    if (!channel?.isTextBased()) throw new Error("Task channel is unavailable");
    if ("messages" in channel) {
      const source = await channel.messages.fetch(from.id).catch(() => undefined);
      if (source) return (await source.startThread({ name })).id;
    }
    if (channel.type !== ChannelType.GuildText) {
      throw new Error("Threads can only be started in task channels");
    }
    return (
      await (channel as TextChannel).threads.create({
        name,
        type: ChannelType.PublicThread,
      })
    ).id;
  }

  async createTaskChannel(options: {
    guildId: string;
    category: string;
    name: string;
    reason: string;
  }): Promise<string> {
    const guild = await this.client.guilds.fetch(options.guildId);
    const category = await findOrCreateCategory(guild, options.category);
    const channel = await guild.channels.create({
      name: options.name,
      type: ChannelType.GuildText,
      parent: category.id,
      reason: options.reason,
    });
    return channel.id;
  }

  async archiveThreads(channelId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (channel?.type !== ChannelType.GuildText) return;
    const active = await channel.threads.fetchActive();
    await Promise.allSettled(
      active.threads.map((thread) => thread.setArchived(true, "Task closed")),
    );
  }

  async recentTurns(msg: IncomingMessage): Promise<ConversationTurn[]> {
    const channel = await this.client.channels.fetch(msg.threadId ?? msg.channelId);
    if (!channel?.isTextBased() || !("messages" in channel)) return [];
    try {
      const fetched = await channel.messages.fetch({ limit: 10, before: msg.id });
      const messages: Message[] = [...fetched.values()].reverse();
      if (channel.isThread() && fetched.size < 10) {
        const starter = await channel.fetchStarterMessage().catch(() => null);
        if (starter && starter.id !== msg.id) messages.unshift(starter);
      }
      return messages
        .map((message) => this.toTurn(message))
        .filter((turn) => turn.content.trim());
    } catch (error) {
      console.warn("Could not fetch recent messages for intent context:", error);
      return [];
    }
  }

  async transcript(
    threadId: string,
    options: { excludeId?: string; limit?: number } = {},
  ): Promise<ConversationTurn[]> {
    const limit = options.limit ?? 100;
    const channel = await this.client.channels.fetch(threadId);
    if (!channel?.isTextBased() || !("messages" in channel)) return [];
    try {
      const collected: Message[] = [];
      let before: string | undefined;
      while (collected.length < limit) {
        const batchLimit = Math.min(100, limit - collected.length);
        const batch = await channel.messages.fetch({ limit: batchLimit, before });
        if (batch.size === 0) break;
        const messages = [...batch.values()];
        collected.push(...messages);
        before = messages[messages.length - 1]?.id;
        if (batch.size < batchLimit) break;
      }

      const messages = collected.reverse();
      if (channel.isThread()) {
        const starter = await channel.fetchStarterMessage().catch(() => null);
        if (starter && !messages.some((message) => message.id === starter.id)) {
          messages.unshift(starter);
        }
      }

      return messages
        .filter((message) => message.id !== options.excludeId)
        .map((message) => this.toTurn(message))
        .filter((turn) => turn.content.trim().length > 0);
    } catch (error) {
      console.warn(
        "Could not fetch thread transcript for session recovery:",
        error instanceof Error ? error.message : String(error),
      );
      return [];
    }
  }

  private toTurn(message: Message): ConversationTurn {
    let content = message.content;
    const botId = this.client.user?.id;
    if (botId) {
      content = content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
    }
    for (const [id, user] of message.mentions.users) {
      content = content.replace(new RegExp(`<@!?${id}>`, "g"), `@${user.username}`);
    }
    return {
      author: message.author.username,
      content,
      isBot: message.author.bot,
    };
  }
}

async function findOrCreateCategory(guild: Guild, name: string) {
  const channels = await guild.channels.fetch();
  const existing = channels.find(
    (channel) =>
      channel?.type === ChannelType.GuildCategory &&
      channel.name.toLowerCase() === name.toLowerCase(),
  );
  if (existing?.type === ChannelType.GuildCategory) return existing;
  return guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    reason: "Umbrella task category",
  });
}
