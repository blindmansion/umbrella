import { describe, expect, test } from "bun:test";
import {
  findGitHubReference,
  parseGitHubUrl,
  parseRepoFullName,
} from "../src/tasks/github";

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
