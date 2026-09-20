import { describe, expect, test } from "bun:test";
import { createMemoryStore } from "../src/adapters/local/store";
import { createCredentialResolver } from "../src/core/credentials";
import { hasCompleteUserConfig } from "../src/core/dashboard";
import {
  effectiveConfigHash,
  sandboxEnvFor,
} from "../src/core/sandboxes";
import { deriveDashboardKeys, sealSecret } from "../shared/crypto";
import type { TaskRecord } from "../src/core/ports";

const SECRET = "0123456789abcdef0123456789abcdef";

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    channelId: "channel-1",
    kind: "feature",
    repo: "owner/repo",
    refNumber: 1,
    branch: "feat/1",
    sandboxId: null,
    status: "ready",
    configHash: null,
    statusMessageId: null,
    model: null,
    context: null,
    createdBy: "user-1",
    createdAt: 0,
    ...overrides,
  };
}

describe("per-user credentials", () => {
  test("resolves git author and decrypts the token", async () => {
    const store = createMemoryStore();
    const { secretBox } = await deriveDashboardKeys(SECRET);
    const sealed = await sealSecret(secretBox, "ghp_secret");
    await store.upsertUserSettings("user-1", {
      userName: "alice",
      gitAuthorName: "Alice",
      gitAuthorEmail: "alice@example.com",
      encryptedToken: sealed,
      tokenHint: "••••cret",
      updatedAt: 42,
    });

    const resolver = createCredentialResolver(store, SECRET)!;
    expect(await resolver(task())).toEqual({
      gitAuthorName: "Alice",
      gitAuthorEmail: "alice@example.com",
      githubToken: "ghp_secret",
      version: 42,
    });
  });

  test("falls back when a task has no creator or settings", async () => {
    const store = createMemoryStore();
    const resolver = createCredentialResolver(store, SECRET)!;
    expect(await resolver(task({ createdBy: null }))).toBeUndefined();
    expect(await resolver(task({ createdBy: "unknown" }))).toBeUndefined();
  });

  test("returns undefined when no dashboard secret is configured", () => {
    const store = createMemoryStore();
    expect(createCredentialResolver(store, undefined)).toBeUndefined();
  });
});

describe("required per-user configuration", () => {
  test("requires a Git author and a token", async () => {
    const store = createMemoryStore();
    expect(await hasCompleteUserConfig(store, "user-1")).toBe(false);

    await store.upsertUserSettings("user-1", {
      gitAuthorName: "Alice",
      gitAuthorEmail: "alice@example.com",
      updatedAt: 1,
    });
    expect(await hasCompleteUserConfig(store, "user-1")).toBe(false);

    await store.upsertUserSettings("user-1", {
      encryptedToken: "sealed",
      tokenHint: "••••cret",
      updatedAt: 2,
    });
    expect(await hasCompleteUserConfig(store, "user-1")).toBe(true);
  });
});

describe("sandbox environment", () => {
  const base = {
    model: "test/model",
    sandboxEnv: { ANTHROPIC_API_KEY: "key" },
    configHash: "hash",
  };

  test("merges the user's configuration over the deployment defaults", () => {
    const env = sandboxEnvFor(base, {
      gitAuthorName: "Alice",
      gitAuthorEmail: "alice@example.com",
      githubToken: "token",
      version: 1,
    });
    expect(env).toMatchObject({
      ANTHROPIC_API_KEY: "key",
      GIT_AUTHOR_NAME: "Alice",
      GIT_COMMITTER_NAME: "Alice",
      GIT_AUTHOR_EMAIL: "alice@example.com",
      GIT_COMMITTER_EMAIL: "alice@example.com",
      GITHUB_TOKEN: "token",
      GH_TOKEN: "token",
    });
  });

  test("changes the config hash when the user's version changes", () => {
    expect(effectiveConfigHash("hash", undefined)).toBe("hash");
    expect(effectiveConfigHash("hash", { version: 1 })).not.toBe(
      effectiveConfigHash("hash", { version: 2 }),
    );
  });
});
