import { describe, expect, test } from "bun:test";
import { createMemoryStore } from "../src/adapters/local/store";
import { configureMessage, createConfigureLink } from "../src/core/dashboard";
import {
  deriveDashboardKeys,
  openSecret,
  sealSecret,
  tokenHint,
} from "../shared/crypto";
import {
  MAGIC_LINK_TTL_SECONDS,
  createMagicLinkToken,
  verifyMagicLinkToken,
} from "../shared/magic-link";
import {
  SESSION_COOKIE,
  createSessionToken,
  parseCookies,
  verifySessionToken,
} from "../shared/session";

const SECRET = "0123456789abcdef0123456789abcdef";

describe("dashboard crypto", () => {
  test("encrypts and decrypts a GitHub token", async () => {
    const { secretBox } = await deriveDashboardKeys(SECRET);
    const sealed = await sealSecret(secretBox, "ghp_example_token");
    expect(sealed).not.toContain("ghp_example_token");
    expect(await openSecret(secretBox, sealed)).toBe("ghp_example_token");
  });

  test("rejects a secret that is too short", async () => {
    expect(deriveDashboardKeys("short")).rejects.toThrow();
  });

  test("derives independent subkeys", async () => {
    const keys = await deriveDashboardKeys(SECRET);
    expect(keys.magicLink).not.toBe(keys.session);
    expect(keys.session).not.toBe(keys.secretBox);
  });

  test("hints at the last four characters of a token", () => {
    expect(tokenHint("ghp_abcdef1234")).toBe("••••1234");
    expect(tokenHint("abc")).toBe("••••");
  });
});

describe("magic links", () => {
  const payload = {
    v: 1 as const,
    g: "guild-1",
    gn: "Umbrella HQ",
    u: "user-1",
    un: "alice",
    a: true,
    j: "nonce-1",
    x: 1_700_000_300,
  };

  test("round-trips a valid token", async () => {
    const { magicLink } = await deriveDashboardKeys(SECRET);
    const token = await createMagicLinkToken(magicLink, payload);
    expect(await verifyMagicLinkToken(magicLink, token, 1_700_000_000)).toEqual(
      payload,
    );
  });

  test("rejects a tampered token", async () => {
    const { magicLink } = await deriveDashboardKeys(SECRET);
    const token = await createMagicLinkToken(magicLink, payload);
    const [body, signature] = token.split(".");
    const tampered = `${body}.${signature!.slice(0, -1)}x`;
    expect(
      await verifyMagicLinkToken(magicLink, tampered, 1_700_000_000),
    ).toBeUndefined();
  });

  test("rejects an expired token", async () => {
    const { magicLink } = await deriveDashboardKeys(SECRET);
    const token = await createMagicLinkToken(magicLink, payload);
    expect(
      await verifyMagicLinkToken(
        magicLink,
        token,
        payload.x + MAGIC_LINK_TTL_SECONDS,
      ),
    ).toBeUndefined();
  });

  test("rejects a token signed with a different secret", async () => {
    const { magicLink } = await deriveDashboardKeys(SECRET);
    const other = await deriveDashboardKeys("ffffffffffffffffffffffffffffffff");
    const token = await createMagicLinkToken(other.magicLink, payload);
    expect(
      await verifyMagicLinkToken(magicLink, token, 1_700_000_000),
    ).toBeUndefined();
  });
});

describe("configure links", () => {
  const dashboard = { url: "https://dash.example.com", secret: SECRET };
  const identity = {
    guildId: "guild-1",
    guildName: "Umbrella HQ",
    userId: "user-1",
    userName: "alice",
    isAdmin: true,
  };
  const now = 1_700_000_000_000;

  async function tokenFrom(url: string): Promise<string> {
    return decodeURIComponent(new URL(url).searchParams.get("token")!);
  }

  test("issues a signed link and stores its single-use nonce", async () => {
    const store = createMemoryStore(() => now);
    const url = await createConfigureLink(store, dashboard, identity, () => now);
    expect(url.startsWith("https://dash.example.com/auth/magic?token=")).toBe(
      true,
    );

    const { magicLink } = await deriveDashboardKeys(SECRET);
    const payload = await verifyMagicLinkToken(
      magicLink,
      await tokenFrom(url),
      Math.floor(now / 1_000),
    );
    expect(payload).toMatchObject({
      g: "guild-1",
      u: "user-1",
      a: true,
      x: Math.floor(now / 1_000) + MAGIC_LINK_TTL_SECONDS,
    });
    expect(payload!.j).toBeTruthy();

    expect(await store.consumeMagicLink(payload!.j, now)).toBeDefined();
    expect(await store.consumeMagicLink(payload!.j, now)).toBeUndefined();
  });

  test("includes the link in the reply message", () => {
    expect(configureMessage("https://dash.example.com/auth/magic?token=x")).toContain(
      "https://dash.example.com/auth/magic?token=x",
    );
  });
});

describe("sessions", () => {
  test("round-trips a session and parses the cookie", async () => {
    const { session } = await deriveDashboardKeys(SECRET);
    const payload = {
      v: 1 as const,
      g: "guild-1",
      gn: "Umbrella HQ",
      u: "user-1",
      un: "alice",
      a: false,
      x: 1_700_000_300,
    };
    const token = await createSessionToken(session, payload);
    expect(await verifySessionToken(session, token, 1_700_000_000)).toEqual(
      payload,
    );
    expect(parseCookies(`${SESSION_COOKIE}=${token}; other=1`)).toEqual({
      [SESSION_COOKIE]: token,
      other: "1",
    });
  });

  test("rejects an expired session", async () => {
    const { session } = await deriveDashboardKeys(SECRET);
    const token = await createSessionToken(session, {
      v: 1,
      g: "guild-1",
      gn: null,
      u: "user-1",
      un: null,
      a: false,
      x: 1_700_000_000,
    });
    expect(
      await verifySessionToken(session, token, 1_700_000_001),
    ).toBeUndefined();
  });
});
