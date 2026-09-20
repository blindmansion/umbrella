import type {
  ConversationTurn,
  Deps,
  IncomingMessage,
  IntentAction,
  IntentContext,
} from "./ports";

export async function classifyAction(
  deps: Deps,
  msg: IncomingMessage,
  context: Omit<IntentContext, "latest">,
): Promise<IntentAction | undefined> {
  if (!msg.text.trim()) return msg.botMentioned ? "chat" : undefined;
  if (!deps.classifier) return msg.botMentioned ? "chat" : undefined;
  const classification = await deps.classifier.classify({
    ...context,
    latest: latestTurn(msg),
  });
  const threshold = deps.config.intentConfidenceThreshold ?? 0.6;
  const action = resolveIntentAction({
    classification,
    botMentioned: msg.botMentioned,
    threshold,
  });
  console.log(
    `Intent for message ${msg.id}: surface=${context.surface} mentioned=${msg.botMentioned} turns=${context.recentTurns.length} directed=${classification?.directedAtBot.toFixed(2) ?? "n/a"} action=${classification?.action ?? "n/a"} confidence=${classification?.confidence.toFixed(2) ?? "n/a"} -> ${action ?? "silent"}`,
  );
  return action;
}

export function resolveIntentAction(options: {
  classification:
    | {
        directedAtBot: number;
        action: IntentAction;
        confidence: number;
      }
    | undefined;
  botMentioned: boolean;
  threshold: number;
}): IntentAction | undefined {
  const { classification, botMentioned, threshold } = options;
  if (!classification) return botMentioned ? "chat" : undefined;
  if (botMentioned) {
    return classification.action === "ignore" ? "chat" : classification.action;
  }
  if (classification.directedAtBot < threshold) return undefined;
  if (classification.action === "ignore") return undefined;
  const actionThreshold =
    classification.action === "reset" || classification.action === "close"
      ? Math.min(1, threshold + 0.15)
      : threshold;
  return classification.confidence >= actionThreshold
    ? classification.action
    : undefined;
}

export function latestTurn(msg: IncomingMessage): ConversationTurn {
  return {
    author: msg.authorName,
    content: msg.text,
    isBot: false,
  };
}

export function buildPendingPrompt(
  recentTurns: ConversationTurn[],
  latest: ConversationTurn,
): string {
  const lastBotIndex = recentTurns.findLastIndex((turn) => turn.isBot);
  const pending = [...recentTurns.slice(lastBotIndex + 1), latest].filter(
    (turn) => !turn.isBot && turn.content.trim(),
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

export function createThreadName(prompt: string): string {
  const cleaned = prompt
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 80) || "OpenCode task";
}
