import { describe, expect, test } from "bun:test";
import {
  buildPendingPrompt,
  buildRehydrationPrompt,
} from "../src/core/routing";
import type { ConversationTurn } from "../src/core/ports";

const human = (content: string, author = "alice"): ConversationTurn => ({
  author,
  content,
  isBot: false,
});
const bot = (content: string): ConversationTurn => ({
  author: "umbrella",
  content,
  isBot: true,
});

describe("buildPendingPrompt", () => {
  test("returns the latest message when nothing is pending", () => {
    expect(
      buildPendingPrompt(
        [human("add a healthcheck"), bot("Done.")],
        human("now add a test"),
      ),
    ).toBe("now add a test");
  });

  test("forwards messages the bot stayed silent on", () => {
    expect(
      buildPendingPrompt(
        [bot("Paste your picks."), human("vite, typescript, react\nno tests")],
        human("respond"),
      ),
    ).toBe("vite, typescript, react\nno tests\n\nrespond");
  });

  test("uses pending messages for a bare mention", () => {
    expect(
      buildPendingPrompt(
        [bot("Paste your picks."), human("vite, typescript, react")],
        human(""),
      ),
    ).toBe("vite, typescript, react");
  });

  test("is empty when a bare mention has nothing pending", () => {
    expect(buildPendingPrompt([bot("Done.")], human(""))).toBe("");
    expect(buildPendingPrompt([], human("  "))).toBe("");
  });

  test("labels speakers when several people are pending", () => {
    expect(
      buildPendingPrompt(
        [bot("Which database?"), human("postgres", "alice")],
        human("and keep the existing schema", "bob"),
      ),
    ).toBe("alice: postgres\n\nbob: and keep the existing schema");
  });

  test("includes everything when the bot has not spoken yet", () => {
    expect(
      buildPendingPrompt([human("context first")], human("then the ask")),
    ).toBe("context first\n\nthen the ask");
  });
});

describe("buildRehydrationPrompt", () => {
  const task = {
    repo: "owner/repo",
    refNumber: 12,
    kind: "feature" as const,
    branch: "feat/12-resumable-sandboxes",
  };

  test("returns the prompt unchanged without prior conversation", () => {
    expect(
      buildRehydrationPrompt({ task, transcript: [], prompt: "continue" }),
    ).toBe("continue");
  });

  test("seeds task context and the transcript before the request", () => {
    const prompt = buildRehydrationPrompt({
      task,
      transcript: [human("add checkpoints"), bot("Cloned the repo.")],
      prompt: "now capture the disk",
    });

    expect(prompt).toContain("owner/repo #12 (feature)");
    expect(prompt).toContain("branch `feat/12-resumable-sandboxes`");
    expect(prompt).toContain("alice: add checkpoints");
    expect(prompt).toContain("umbrella: Cloned the repo.");
    expect(prompt.endsWith("now capture the disk")).toBe(true);
  });

  test("escapes backticks in the branch name", () => {
    const prompt = buildRehydrationPrompt({
      task: { ...task, branch: "feat/`odd`" },
      transcript: [human("hi")],
      prompt: "go",
    });
    expect(prompt).toContain("branch `feat/'odd'`");
  });
});
