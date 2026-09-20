import { describe, expect, test } from "bun:test";
import {
  buildFirstPrompt,
  buildReferenceContext,
  buildRepoContext,
} from "../src/tasks/context";
import type { GitHubReference } from "../src/tasks/github";

const reference: GitHubReference = {
  owner: "blindmansion",
  name: "umbrella",
  number: 22,
  urlKind: "issue",
};

describe("buildReferenceContext", () => {
  test("describes the issue with its title, url, and branch", () => {
    const context = buildReferenceContext({
      kind: "feature",
      repo: "blindmansion/umbrella",
      refNumber: 22,
      branch: "feat/22-put-task-context",
      reference,
      metadata: { title: "Put task context into sessions" },
    });

    expect(context).toContain("Issue: blindmansion/umbrella#22");
    expect(context).toContain("Put task context into sessions");
    expect(context).toContain(
      "https://github.com/blindmansion/umbrella/issues/22",
    );
    expect(context).toContain("Branch: feat/22-put-task-context");
    expect(context).not.toContain("description:");
  });

  test("includes the issue body and labels pull requests", () => {
    const context = buildReferenceContext({
      kind: "review",
      repo: "blindmansion/umbrella",
      refNumber: 12,
      branch: "feature/thing",
      reference: { ...reference, number: 12, urlKind: "pull" },
      metadata: { title: "Add a thing", body: "Please review the changes." },
    });

    expect(context).toContain("Pull request: blindmansion/umbrella#12");
    expect(context).toContain("https://github.com/blindmansion/umbrella/pull/12");
    expect(context).toContain("Please review the changes.");
  });

  test("truncates long issue bodies", () => {
    const context = buildReferenceContext({
      kind: "feature",
      repo: "blindmansion/umbrella",
      refNumber: 22,
      branch: "main",
      reference,
      metadata: { body: "x".repeat(5_000) },
    });

    expect(context).toContain("(truncated)");
    expect(context).not.toContain("x".repeat(4_001));
    expect(context.length).toBeLessThan(4_300);
  });
});

describe("buildRepoContext", () => {
  test("records the repository, branch, and original request", () => {
    const context = buildRepoContext({
      kind: "planning",
      repo: "blindmansion/umbrella",
      branch: "main",
      request: "add a health check endpoint",
    });

    expect(context).toContain("Repository: blindmansion/umbrella");
    expect(context).toContain("Branch: main");
    expect(context).toContain("add a health check endpoint");
  });

  test("omits the request when there isn't one", () => {
    const context = buildRepoContext({
      kind: "planning",
      repo: "blindmansion/umbrella",
      branch: "main",
    });

    expect(context).not.toContain("Original request:");
  });
});

describe("buildFirstPrompt", () => {
  test("prepends the context to the prompt", () => {
    expect(buildFirstPrompt("context", "do the thing")).toBe(
      "context\n\n---\n\ndo the thing",
    );
  });

  test("returns the prompt unchanged without context", () => {
    expect(buildFirstPrompt(null, "do the thing")).toBe("do the thing");
    expect(buildFirstPrompt("  ", "do the thing")).toBe("do the thing");
  });

  test("falls back to the context when the prompt is empty", () => {
    expect(buildFirstPrompt("context", "  ")).toBe("context");
  });
});
