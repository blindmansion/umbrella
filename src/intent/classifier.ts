export const INTENT_ACTIONS = [
  "chat",
  "create_task",
  "reset",
  "close",
  "ignore",
] as const;

export type IntentAction = (typeof INTENT_ACTIONS)[number];

export type IntentSurface = "task_channel" | "thread" | "other";

export type ConversationTurn = {
  author: string;
  content: string;
  isBot: boolean;
};

export type IntentContext = {
  surface: IntentSurface;
  botMentioned: boolean;
  taskActive: boolean;
  hasSession: boolean;
  recentTurns: ConversationTurn[];
  latest: ConversationTurn;
};

export type IntentClassification = {
  directedAtBot: number;
  action: IntentAction;
  confidence: number;
};

export type IntentQuestions = {
  directed_at_bot: {
    type: "noul";
    instructions: string;
    criteria: { true: string; false: string };
  };
  action: {
    type: "choice";
    instructions: string;
    criteria: Record<IntentAction, string>;
  };
};

const ACTION_CRITERIA: Record<IntentAction, string> = {
  chat: "Start or continue a conversation with the bot inside an existing task (`active_task` is true) or as a reply to it: a prompt, question, or instruction for it to act on, or a reply to it such as an answer to its question, requested details, a correction, or feedback on its last message.",
  create_task:
    "Set up a new task workspace so the bot can start work. This includes sharing a GitHub issue or pull request URL, or, when `active_task` is false, asking the bot to take on a coding task, question, or request in the server's configured repository without a URL.",
  reset:
    "Reset, restart, or rebuild the current session or sandbox so the bot starts over.",
  close:
    "Close, archive, or tear down the current task and its sandbox.",
  ignore:
    "Not meant for the bot: humans talking to each other, reactions, or a message telling the bot to wait or do nothing.",
};

export function buildIntentQuestions(): IntentQuestions {
  return {
    directed_at_bot: {
      type: "noul",
      instructions:
        "Does the author of `latest_message` expect the bot to respond to it? Use `conversation` and `bot_spoke_last` to judge who the message is for. No explicit mention is needed.",
      criteria: {
        true: "The message is meant for the bot: a request, question, or instruction it can carry out that is not addressed to another person (such as asking for work on a linked GitHub issue or pull request), or a reply to the bot such as answering its question, supplying details it asked for, correcting it, or continuing the exchange with it.",
        false: "The message is meant for another person, is chatter between humans, or tells the bot to wait or do nothing.",
      },
    },
    action: {
      type: "choice",
      instructions: "What does the latest message want the bot to do?",
      criteria: { ...ACTION_CRITERIA },
    },
  };
}

export function buildIntentState(context: IntentContext): Record<string, unknown> {
  return {
    surface:
      context.surface === "thread"
        ? "an OpenCode session thread inside a task channel"
        : context.surface === "task_channel"
          ? "a task channel backed by a sandbox"
          : "a regular server channel that is not a task channel",
    bot_mentioned: context.botMentioned,
    active_task: context.taskActive,
    existing_session: context.hasSession,
    bot_spoke_last: context.recentTurns.at(-1)?.isBot ?? false,
    conversation: context.recentTurns.map((turn) => ({
      speaker: turn.isBot ? "bot" : turn.author,
      message: turn.content,
    })),
    latest_message: {
      speaker: context.latest.isBot ? "bot" : context.latest.author,
      message: context.latest.content,
    },
  };
}

type NoulAnswer = { type: "noul"; noul: number };
type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
type Answer = NoulAnswer | ChoiceAnswer;

type SystemOneResponse = {
  model?: string;
  answers: Record<string, Answer>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export type ClassifyOptions = {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
};

const DEFAULT_BASE_URL = "https://api.typesafe.ai/v1";
const DEFAULT_TIMEOUT_MS = 15_000;
const RETRYABLE_STATUSES = new Set([429, 529]);

export async function classifyMessage(
  context: IntentContext,
  options: ClassifyOptions,
): Promise<IntentClassification | undefined> {
  const { apiKey, model = "jev-latest" } = options;
  if (!apiKey) return undefined;

  const response = await requestSystemOne(
    {
      state: buildIntentState(context),
      model,
      questions: buildIntentQuestions(),
    },
    options,
  ).catch((error) => {
    console.error(
      "Could not classify message intent with TypeSafe:",
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  });

  return response ? parseIntentClassification(response) : undefined;
}

export function parseIntentClassification(
  response: SystemOneResponse,
): IntentClassification | undefined {
  const directed = response.answers.directed_at_bot;
  const action = response.answers.action;
  if (!directed || directed.type !== "noul") return undefined;
  if (!action || action.type !== "choice") return undefined;

  const intentAction = action.choice as IntentAction;
  if (!INTENT_ACTIONS.includes(intentAction)) return undefined;

  return {
    directedAtBot: directed.noul,
    action: intentAction,
    confidence: action.confidence,
  };
}

export function resolveIntentAction(options: {
  classification: IntentClassification | undefined;
  botMentioned: boolean;
  threshold: number;
}): IntentAction | undefined {
  const { classification, botMentioned, threshold } = options;

  if (!classification) {
    return botMentioned ? "chat" : undefined;
  }

  if (botMentioned) {
    return classification.action === "ignore" ? "chat" : classification.action;
  }

  if (classification.directedAtBot < threshold) return undefined;
  if (classification.action === "ignore") return undefined;
  if (classification.confidence < actionThreshold(classification.action, threshold)) {
    return undefined;
  }
  return classification.action;
}

function actionThreshold(action: IntentAction, threshold: number): number {
  if (action === "reset" || action === "close") {
    return Math.min(1, threshold + 0.15);
  }
  return threshold;
}

async function requestSystemOne(
  body: {
    state: unknown;
    model: string;
    questions: IntentQuestions;
  },
  options: ClassifyOptions,
): Promise<SystemOneResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let attempt = 0;
  for (;;) {
    attempt += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/systemone`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      if (RETRYABLE_STATUSES.has(response.status) && attempt < 3) {
        await delay(attempt * 250);
        continue;
      }
      const detail = await response.text().catch(() => "");
      throw new Error(
        `TypeSafe request failed with ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      );
    }

    return (await response.json()) as SystemOneResponse;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
