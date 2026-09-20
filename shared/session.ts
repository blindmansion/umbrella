import { signPayload, verifyPayload } from "./crypto";

export const SESSION_TTL_SECONDS = 12 * 60 * 60;
export const SESSION_COOKIE = "umbrella_session";

export type SessionPayload = {
  v: 1;
  g: string;
  gn: string | null;
  u: string;
  un: string | null;
  a: boolean;
  x: number;
};

export function createSessionToken(
  key: CryptoKey,
  payload: SessionPayload,
): Promise<string> {
  return signPayload(key, payload);
}

export async function verifySessionToken(
  key: CryptoKey,
  token: string,
  nowSeconds: number,
): Promise<SessionPayload | undefined> {
  const payload = await verifyPayload<SessionPayload>(key, token);
  if (!payload || payload.v !== 1) return undefined;
  if (typeof payload.x !== "number" || payload.x <= nowSeconds) return undefined;
  if (!payload.u || !payload.g) return undefined;
  return payload;
}

export function parseCookies(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}
