import type {
  ChatPlatform,
  ConversationTurn,
  IncomingMessage,
  MessageRef,
} from "../../core/ports";

export class TerminalChat implements ChatPlatform {
  private sequence = 0;
  private readonly turns = new Map<string, ConversationTurn[]>();

  async reply(to: IncomingMessage, text: string): Promise<MessageRef> {
    return this.send(to.threadId ?? to.channelId, text);
  }

  async send(channelId: string, text: string): Promise<MessageRef> {
    console.log(`[${channelId}] umbrella: ${text}`);
    this.record(channelId, { author: "umbrella", content: text, isBot: true });
    return { id: `message-${++this.sequence}`, channelId };
  }

  async edit(ref: MessageRef, text: string): Promise<void> {
    console.log(`[${ref.channelId}] umbrella (edit ${ref.id}): ${text}`);
  }

  async pin(ref: MessageRef): Promise<void> {
    console.log(`[${ref.channelId}] pinned ${ref.id}`);
  }

  async startThread(from: IncomingMessage, name: string): Promise<string> {
    const id = `thread-${++this.sequence}`;
    console.log(`[${from.channelId}] started ${id}: ${name}`);
    return id;
  }

  async createTaskChannel(options: {
    guildId: string;
    category: string;
    name: string;
    reason: string;
  }): Promise<string> {
    const id = `task-${++this.sequence}`;
    console.log(`[${options.guildId}] created ${id} (${options.category}/${options.name})`);
    return id;
  }

  async archiveThreads(channelId: string): Promise<void> {
    console.log(`[${channelId}] archived active threads`);
  }

  async recentTurns(msg: IncomingMessage): Promise<ConversationTurn[]> {
    return [...(this.turns.get(msg.threadId ?? msg.channelId) ?? [])].slice(-10);
  }

  accept(msg: IncomingMessage): void {
    this.record(msg.threadId ?? msg.channelId, {
      author: msg.authorName,
      content: msg.text,
      isBot: false,
    });
  }

  private record(channelId: string, turn: ConversationTurn): void {
    const turns = this.turns.get(channelId) ?? [];
    turns.push(turn);
    this.turns.set(channelId, turns.slice(-20));
  }
}
