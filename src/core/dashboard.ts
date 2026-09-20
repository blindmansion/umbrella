import { deriveDashboardKeys, type DashboardKeys } from "../../shared/crypto";
import {
  MAGIC_LINK_TTL_SECONDS,
  createMagicLinkToken,
} from "../../shared/magic-link";
import type { StateStore } from "./ports";

export type ConfigureIdentity = {
  guildId: string;
  guildName: string | null;
  userId: string;
  userName: string | null;
  isAdmin: boolean;
};

export type DashboardConfig = { url: string; secret: string };

const keyCache = new Map<string, Promise<DashboardKeys>>();

function keysFor(secret: string): Promise<DashboardKeys> {
  let keys = keyCache.get(secret);
  if (!keys) {
    keys = deriveDashboardKeys(secret);
    keyCache.set(secret, keys);
  }
  return keys;
}

/**
 * Creates a single-use magic link that signs the requesting user into the
 * dashboard scoped to their Discord server. The identity, access level, and
 * server travel inside the signed token; only the nonce is stored server-side
 * so the link can be consumed exactly once.
 */
export async function createConfigureLink(
  store: StateStore,
  dashboard: DashboardConfig,
  identity: ConfigureIdentity,
  now: () => number = Date.now,
): Promise<string> {
  const issuedAt = now();
  const nonce = crypto.randomUUID();
  await store.createMagicLink({
    nonce,
    guildId: identity.guildId,
    guildName: identity.guildName,
    userId: identity.userId,
    userName: identity.userName,
    isAdmin: identity.isAdmin,
    expiresAt: issuedAt + MAGIC_LINK_TTL_SECONDS * 1_000,
    consumedAt: null,
    createdAt: issuedAt,
  });
  const keys = await keysFor(dashboard.secret);
  const token = await createMagicLinkToken(keys.magicLink, {
    v: 1,
    g: identity.guildId,
    gn: identity.guildName,
    u: identity.userId,
    un: identity.userName,
    a: identity.isAdmin,
    j: nonce,
    x: Math.floor(issuedAt / 1_000) + MAGIC_LINK_TTL_SECONDS,
  });
  return `${dashboard.url}/auth/magic?token=${encodeURIComponent(token)}`;
}

export function configureMessage(url: string): string {
  return [
    "Here is your one-time dashboard link. It signs you in instantly and is",
    `valid for ${MAGIC_LINK_TTL_SECONDS / 60} minutes or a single click:`,
    url,
  ].join("\n");
}
