import type { ConversationTurn } from "./classifier";

/**
 * Build the prompt for a chat action from the latest message plus any human
 * messages the bot has not answered yet. Messages the classifier ignored never
 * reach OpenCode on their own, so they are forwarded with the next message
 * that does trigger the bot, such as a bare mention or a short "respond".
 */
export function buildPendingPrompt(
  recentTurns: ConversationTurn[],
  latest: ConversationTurn,
): string {
  const lastBotIndex = recentTurns.findLastIndex((turn) => turn.isBot);
  const pending = [...recentTurns.slice(lastBotIndex + 1), latest].filter(
    (turn) => !turn.isBot && turn.content.trim().length > 0,
  );

  const authors = new Set(pending.map((turn) => turn.author));
  return pending
    .map((turn) =>
      authors.size > 1
        ? `${turn.author}: ${turn.content.trim()}`
        : turn.content.trim(),
    )
    .join("\n\n");
}
