import { describe, expect, test } from "bun:test";
import { createChannelName, slugify } from "../src/core/naming";

describe("createChannelName", () => {
  test("uses the kind and issue number when a reference exists", () => {
    expect(createChannelName("feature", 14, "add-dark-mode")).toBe(
      "feat-14-add-dark-mode",
    );
  });

  test("uses a task prefix when there is no reference", () => {
    expect(createChannelName("planning", null, "how-does-this-work")).toBe(
      "task-how-does-this-work",
    );
  });

  test("bounds the channel name length", () => {
    expect(createChannelName("feature", 1, "x".repeat(200)).length).toBeLessThanOrEqual(
      100,
    );
  });
});

describe("slugify", () => {
  test("normalizes a prompt into a channel-safe slug", () => {
    expect(slugify("How does the Sandbox Manager work?")).toBe(
      "how-does-the-sandbox-manager-work",
    );
  });
});
