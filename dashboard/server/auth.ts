import {
  deriveDashboardKeys,
  type DashboardKeys,
} from "../../shared/crypto";
import {
  MAGIC_LINK_TTL_SECONDS,
  verifyMagicLinkToken,
} from "../../shared/magic-link";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  createSessionToken,
  parseCookies,
  verifySessionToken,
  type SessionPayload,
} from "../../shared/session";
import { pool } from "./db";
import { env } from "./env";

let keys: DashboardKeys | undefined;

export async function initAuth(): Promise<void> {
  keys = await deriveDashboardKeys(env.dashboardSecret);
}

function requireKeys(): DashboardKeys {
  if (!keys) throw new Error("Auth is not initialised");
  return keys;
}

export function secretBox(): CryptoKey {
  return requireKeys().secretBox;
}

export async function readSession(
  request: Request,
): Promise<SessionPayload | undefined> {
  const token = parseCookies(request.headers.get("cookie"))[SESSION_COOKIE];
  if (!token) return undefined;
  return verifySessionToken(
    requireKeys().session,
    token,
    Math.floor(Date.now() / 1_000),
  );
}

export function sessionCookie(token: string): string {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (env.secureCookies) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearSessionCookie(): string {
  const attributes = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (env.secureCookies) attributes.push("Secure");
  return attributes.join("; ");
}

/**
 * Verifies a magic link and exchanges it for a session. Returns the session
 * payload, or undefined when the token is invalid, expired, or already used.
 */
export async function exchangeMagicLink(
  token: string,
): Promise<SessionPayload | undefined> {
  const now = Math.floor(Date.now() / 1_000);
  const payload = await verifyMagicLinkToken(
    requireKeys().magicLink,
    token,
    now,
  );
  if (!payload) return undefined;

  const { rows } = await pool.query(
    `UPDATE magic_links
     SET consumed_at = $2
     WHERE nonce = $1 AND consumed_at IS NULL AND expires_at > $2
     RETURNING nonce`,
    [payload.j, now * 1_000],
  );
  if (rows.length === 0) return undefined;

  const session: SessionPayload = {
    v: 1,
    g: payload.g,
    gn: payload.gn,
    u: payload.u,
    un: payload.un,
    a: payload.a,
    x: now + SESSION_TTL_SECONDS,
  };
  return session;
}

export async function sessionForPayload(
  session: SessionPayload,
): Promise<string> {
  return createSessionToken(requireKeys().session, session);
}

export { MAGIC_LINK_TTL_SECONDS };
