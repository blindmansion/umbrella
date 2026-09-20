import { describe, expect, spyOn, test } from "bun:test";
import {
  buildIntentQuestions,
  buildIntentState,
  classifyMessage,
  parseIntentClassification,
  resolveIntentAction,
  type IntentContext,
} from "../src/intent/classifier";

function context(overrides: Partial<IntentContext> = {}): IntentContext {
  return {
    surface: "task_channel",
    botMentioned: false,
    taskActive: true,
    hasSession: false,
    recentTurns: [
      { author: "alice", content: "should we use postgres here?", isBot: false },
      { author: "umbrella", content: "Working on it...", isBot: true },
    ],
    latest: {
      author: "alice",
      content: "start on the failing login test",
      isBot: false,
    },
    ...overrides,
  };
}

describe("buildIntentState", () => {
  test("includes surface, flags, transcript, and latest message", () => {
    const state = buildIntentState(context());

    expect(state.bot_mentioned).toBe(false);
    expect(state.active_task).toBe(true);
    expect(state.existing_session).toBe(false);
    expect(state.bot_spoke_last).toBe(true);
    expect(state.surface).toContain("task channel");
    expect(state.conversation).toEqual([
      { speaker: "alice", message: "should we use postgres here?" },
      { speaker: "bot", message: "Working on it..." },
    ]);
    expect(state.latest_message).toEqual({
      speaker: "alice",
      message: "start on the failing login test",
    });
  });

  test("reports when a human spoke last or nobody has spoken", () => {
    expect(
      buildIntentState(
        context({
          recentTurns: [
            { author: "alice", content: "lunch?", isBot: false },
          ],
        }),
      ).bot_spoke_last,
    ).toBe(false);
    expect(buildIntentState(context({ recentTurns: [] })).bot_spoke_last).toBe(
      false,
    );
  });

  test("describes threads and untracked channels", () => {
    expect(buildIntentState(context({ surface: "thread" })).surface).toContain(
      "session thread",
    );
    expect(buildIntentState(context({ surface: "other" })).surface).toContain(
      "not a task channel",
    );
  });
});

describe("buildIntentQuestions", () => {
  test("asks a noul direction question and a choice action question", () => {
    const questions = buildIntentQuestions();

    expect(questions.directed_at_bot.type).toBe("noul");
    expect(questions.action.type).toBe("choice");
    expect(Object.keys(questions.action.criteria)).toEqual([
      "chat",
      "create_task",
      "reset",
      "close",
      "ignore",
    ]);
  });
});

describe("parseIntentClassification", () => {
  test("reads a valid response", () => {
    const classification = parseIntentClassification({
      answers: {
        directed_at_bot: { type: "noul", noul: 0.9 },
        action: {
          type: "choice",
          choice: "chat",
          probabilities: { chat: 0.9, ignore: 0.1 },
          confidence: 0.8,
        },
      },
    });

    expect(classification).toEqual({
      directedAtBot: 0.9,
      action: "chat",
      confidence: 0.8,
    });
  });

  test("rejects unknown actions and malformed answers", () => {
    expect(
      parseIntentClassification({
        answers: {
          directed_at_bot: { type: "noul", noul: 0.9 },
          action: {
            type: "choice",
            choice: "dance",
            probabilities: {},
            confidence: 0.8,
          },
        },
      }),
    ).toBeUndefined();

    expect(
      parseIntentClassification({
        answers: {
          directed_at_bot: { type: "noul", noul: 0.9 },
        },
      }),
    ).toBeUndefined();
  });
});

describe("resolveIntentAction", () => {
  test("falls back to chat when the bot is mentioned and classification is unavailable", () => {
    expect(
      resolveIntentAction({
        classification: undefined,
        botMentioned: true,
        threshold: 0.6,
      }),
    ).toBe("chat");
    expect(
      resolveIntentAction({
        classification: undefined,
        botMentioned: false,
        threshold: 0.6,
      }),
    ).toBeUndefined();
  });

  test("ignores unmentioned messages below the direction threshold", () => {
    expect(
      resolveIntentAction({
        classification: { directedAtBot: 0.4, action: "chat", confidence: 1 },
        botMentioned: false,
        threshold: 0.6,
      }),
    ).toBeUndefined();
  });

  test("ignores low-confidence actions even when directed at the bot", () => {
    expect(
      resolveIntentAction({
        classification: { directedAtBot: 0.9, action: "chat", confidence: 0.5 },
        botMentioned: false,
        threshold: 0.6,
      }),
    ).toBeUndefined();
  });

  test("acts on confident, directed messages", () => {
    expect(
      resolveIntentAction({
        classification: {
          directedAtBot: 0.9,
          action: "create_task",
          confidence: 0.9,
        },
        botMentioned: false,
        threshold: 0.6,
      }),
    ).toBe("create_task");
  });

  test("requires more confidence for destructive actions", () => {
    const classification = {
      directedAtBot: 0.9,
      action: "close" as const,
      confidence: 0.65,
    };
    expect(
      resolveIntentAction({ classification, botMentioned: false, threshold: 0.6 }),
    ).toBeUndefined();
    expect(
      resolveIntentAction({ classification, botMentioned: true, threshold: 0.6 }),
    ).toBe("close");
  });

  test("a mention overrides an ambiguous ignore", () => {
    expect(
      resolveIntentAction({
        classification: { directedAtBot: 0.2, action: "ignore", confidence: 0.9 },
        botMentioned: true,
        threshold: 0.6,
      }),
    ).toBe("chat");
  });
});

describe("classifyMessage", () => {
  test("posts the state and questions and returns the parsed answer", async () => {
    let captured: { url: string; body: unknown } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(String(init.body)) };
      return new Response(
        JSON.stringify({
          model: "jev-test",
          answers: {
            directed_at_bot: { type: "noul", noul: 0.88 },
            action: {
              type: "choice",
              choice: "create_task",
              probabilities: { create_task: 0.9, chat: 0.1 },
              confidence: 0.82,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const classification = await classifyMessage(context(), {
      apiKey: "test-key",
      fetchImpl,
    });

    expect(classification).toEqual({
      directedAtBot: 0.88,
      action: "create_task",
      confidence: 0.82,
    });
    expect(captured?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((captured?.body as { model: string }).model).toBe("jev-latest");
    expect(
      (captured?.body as { questions: { action: unknown } }).questions.action,
    ).toBeDefined();
  });

  test("returns undefined when the API fails", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const spy = spyOn(console, "error").mockImplementation(() => {});

    try {
      const classification = await classifyMessage(context(), {
        apiKey: "test-key",
        fetchImpl,
      });

      expect(classification).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
