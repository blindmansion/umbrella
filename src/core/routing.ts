import type {
  ConversationTurn,
  Deps,
  IncomingMessage,
  IntentAction,
  IntentContext,
  TaskRecord,
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

/**
 * Seed a fresh OpenCode session with the task's context and the messages the
 * thread already exchanged. Used when a sandbox was rebuilt without a usable
 * checkpoint, so the stored OpenCode session can't be resumed.
 */
export function buildRehydrationPrompt(options: {
  task: Pick<TaskRecord, "repo" | "refNumber" | "kind" | "branch">;
  transcript: ConversationTurn[];
  prompt: string;
}): string {
  const { task, transcript, prompt } = options;
  const converse = transcript.filter((turn) => turn.content.trim().length > 0);
  if (converse.length === 0) return prompt;

  const reference = task.refNumber === null ? "" : ` #${task.refNumber}`;
  const conversation = converse
    .map((turn) => `${turn.author}: ${turn.content.trim()}`)
    .join("\n\n");

  return [
    "An OpenCode session for this task was replaced because its sandbox was rebuilt. Continue the work below in a fresh session.",
    "",
    `Task: ${task.repo}${reference} (${task.kind}), branch \`${task.branch.replaceAll("`", "'")}\``,
    "Earlier conversation:",
    conversation,
    "Current request:",
    prompt,
  ].join("\n");
}

export function createThreadName(prompt: string): string {
  const cleaned = prompt
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 80) || "OpenCode task";
}
