import { signPayload, verifyPayload } from "./crypto";

export const MAGIC_LINK_TTL_SECONDS = 5 * 60;

/**
 * Everything a dashboard session needs, encoded into the link so the click
 * carries auth, identity, and server information. `j` is a random nonce stored
 * server-side; it is what makes the link single-use.
 */
export type MagicLinkPayload = {
  v: 1;
  /** Discord guild (server) id. */
  g: string;
  /** Discord guild name, for display. */
  gn: string | null;
  /** Discord user id. */
  u: string;
  /** Discord user name, for display. */
  un: string | null;
  /** Whether the user can manage the guild. */
  a: boolean;
  /** Single-use nonce, matched against the `magic_links` store. */
  j: string;
  /** Expiry, in epoch seconds. */
  x: number;
};

export function createMagicLinkToken(
  key: CryptoKey,
  payload: MagicLinkPayload,
): Promise<string> {
  return signPayload(key, payload);
}

/**
 * Verifies a magic link's signature and expiry. Consuming the nonce is a
 * separate step so this stays a pure function.
 */
export async function verifyMagicLinkToken(
  key: CryptoKey,
  token: string,
  nowSeconds: number,
): Promise<MagicLinkPayload | undefined> {
  const payload = await verifyPayload<MagicLinkPayload>(key, token);
  if (!payload || payload.v !== 1) return undefined;
  if (typeof payload.x !== "number" || payload.x <= nowSeconds) return undefined;
  if (!payload.u || !payload.g || !payload.j) return undefined;
  return payload;
}
