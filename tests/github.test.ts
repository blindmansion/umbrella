import { describe, expect, test } from "bun:test";
import {
  buildIssueUrl,
  findGitHubReference,
  parseGitHubUrl,
  parseRepoFullName,
  rankIssues,
} from "../src/core/github";
import { fetchOpenIssues, fetchReferenceState } from "../src/adapters/github/client";
import type { GitHubIssue } from "../src/core/ports";

describe("findGitHubReference", () => {
  test("extracts an issue reference from surrounding text", () => {
    expect(
      findGitHubReference(
        "please take a look at https://github.com/blindmansion/umbrella/issues/2 thanks",
      ),
    ).toEqual({
      owner: "blindmansion",
      name: "umbrella",
      number: 2,
      urlKind: "issue",
    });
  });

  test("extracts a pull request reference", () => {
    expect(
      findGitHubReference("https://github.com/owner/repo/pull/12"),
    ).toEqual({ owner: "owner", name: "repo", number: 12, urlKind: "pull" });
  });

  test("ignores non-github links and non issue/pull paths", () => {
    expect(findGitHubReference("https://example.com/issues/2")).toBeUndefined();
    expect(
      findGitHubReference("https://github.com/owner/repo"),
    ).toBeUndefined();
  });

  test("falls back to a later valid link when the first is malformed", () => {
    expect(
      findGitHubReference(
        "https://github.com/owner/repo/issues/0 then https://github.com/owner/repo/pull/7",
      ),
    ).toEqual({ owner: "owner", name: "repo", number: 7, urlKind: "pull" });
  });
});

describe("parseGitHubUrl", () => {
  test("rejects non-github hosts and protocols", () => {
    expect(parseGitHubUrl("http://github.com/owner/repo/issues/1")).toBeUndefined();
    expect(parseGitHubUrl("https://gitlab.com/owner/repo/issues/1")).toBeUndefined();
  });
});

describe("rankIssues", () => {
  const issues: GitHubIssue[] = [
    { number: 1, title: "Add autocomplete", url: "https://github.com/o/r/issues/1" },
    { number: 2, title: "Fix autocomplete crash", url: "https://github.com/o/r/issues/2" },
    { number: 20, title: "Unrelated work", url: "https://github.com/o/r/issues/20" },
  ];

  test("returns every issue for a blank query", () => {
    expect(rankIssues(issues, "   ")).toEqual(issues);
  });

  test("matches by issue number", () => {
    expect(rankIssues(issues, "#20").map((issue) => issue.number)).toEqual([20]);
    expect(rankIssues(issues, "20").map((issue) => issue.number)).toEqual([20]);
  });

  test("matches title substrings and ranks the earlier match higher", () => {
    expect(
      rankIssues(issues, "autocomplete").map((issue) => issue.number),
    ).toEqual([1, 2]);
  });

  test("supports fuzzy subsequence matches across tokens", () => {
    expect(rankIssues(issues, "fx acl").map((issue) => issue.number)).toEqual([
      2,
    ]);
  });

  test("drops issues that match none of the tokens", () => {
    expect(rankIssues(issues, "nonexistent")).toEqual([]);
  });
});

describe("buildIssueUrl", () => {
  test("builds an issue URL from owner/name", () => {
    expect(buildIssueUrl({ owner: "owner", name: "repo" }, 7)).toBe(
      "https://github.com/owner/repo/issues/7",
    );
  });
});

describe("fetchOpenIssues", () => {
  test("returns open issues and skips pull requests", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          {
            number: 3,
            title: "Keep me",
            html_url: "https://github.com/owner/repo/issues/3",
          },
          {
            number: 4,
            title: "A pull request",
            pull_request: { url: "https://api.github.com/..." },
          },
        ]),
        { status: 200 },
      )) as unknown as typeof fetch;

    try {
      expect(
        await fetchOpenIssues({ owner: "owner", name: "repo" }, "token"),
      ).toEqual([
        {
          number: 3,
          title: "Keep me",
          url: "https://github.com/owner/repo/issues/3",
        },
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("returns an empty list when the request fails", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;

    try {
      expect(
        await fetchOpenIssues({ owner: "owner", name: "repo" }),
      ).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("fetchReferenceState", () => {
  test("reads a closed issue", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ state: "closed" }), {
        status: 200,
      })) as unknown as typeof fetch;

    try {
      expect(
        await fetchReferenceState({
          owner: "owner",
          name: "repo",
          number: 7,
          urlKind: "issue",
        }),
      ).toEqual({ state: "closed", merged: false });
    } finally {
      globalThis.fetch = original;
    }
  });

  test("reads a merged pull request", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ state: "closed", merged: true }), {
        status: 200,
      })) as unknown as typeof fetch;

    try {
      expect(
        await fetchReferenceState({
          owner: "owner",
          name: "repo",
          number: 7,
          urlKind: "pull",
        }),
      ).toEqual({ state: "closed", merged: true });
    } finally {
      globalThis.fetch = original;
    }
  });

  test("returns undefined when the request fails or the body is unexpected", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("nope", { status: 404 })) as unknown as typeof fetch;
    try {
      expect(
        await fetchReferenceState({
          owner: "owner",
          name: "repo",
          number: 7,
          urlKind: "issue",
        }),
      ).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ state: "weird" }), {
        status: 200,
      })) as unknown as typeof fetch;
    try {
      expect(
        await fetchReferenceState({
          owner: "owner",
          name: "repo",
          number: 7,
          urlKind: "issue",
        }),
      ).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("parseRepoFullName", () => {
  test("accepts an owner/name pair", () => {
    expect(parseRepoFullName("blindmansion/umbrella")).toEqual({
      owner: "blindmansion",
      name: "umbrella",
    });
  });

  test("trims surrounding whitespace", () => {
    expect(parseRepoFullName("  owner/repo  ")).toEqual({
      owner: "owner",
      name: "repo",
    });
  });

  test("rejects URLs and malformed values", () => {
    expect(
      parseRepoFullName("https://github.com/owner/repo"),
    ).toBeUndefined();
    expect(parseRepoFullName("owner")).toBeUndefined();
    expect(parseRepoFullName("owner/repo/extra")).toBeUndefined();
    expect(parseRepoFullName("")).toBeUndefined();
  });
});
