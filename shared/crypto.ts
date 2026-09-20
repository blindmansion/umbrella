import { decodeBytes, decodeJson, encodeBytes, encodeJson } from "./base64url";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HKDF_SALT = encoder.encode("umbrella-dashboard/v1");

/** TS 5.7+ types Uint8Array over ArrayBufferLike; WebCrypto wants ArrayBuffer. */
function buffer(value: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(value.byteLength);
  new Uint8Array(copy).set(value);
  return copy;
}

export type DashboardKeys = {
  /** HMAC key for magic-link tokens. */
  magicLink: CryptoKey;
  /** HMAC key for session cookies. */
  session: CryptoKey;
  /** AES-256-GCM key for encrypting user secrets at rest. */
  secretBox: CryptoKey;
};

async function deriveBits(
  material: CryptoKey,
  info: string,
  bits: number,
): Promise<Uint8Array> {
  const derived = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: HKDF_SALT,
      info: buffer(encoder.encode(info)),
    },
    material,
    bits,
  );
  return new Uint8Array(derived);
}

/**
 * Derives the independent subkeys Umbrella and the dashboard share from
 * `DASHBOARD_SECRET`. Keeping the keys separate means a leaked magic link
 * cannot be used to forge a session, and neither can decrypt stored secrets.
 */
export async function deriveDashboardKeys(
  secret: string,
): Promise<DashboardKeys> {
  if (secret.length < 16) {
    throw new Error("DASHBOARD_SECRET must be at least 16 characters");
  }
  const material = await crypto.subtle.importKey(
    "raw",
    buffer(encoder.encode(secret)),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const hmac = (bits: Uint8Array) =>
    crypto.subtle.importKey(
      "raw",
      buffer(bits),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  return {
    magicLink: await hmac(await deriveBits(material, "magic-link", 256)),
    session: await hmac(await deriveBits(material, "session", 256)),
    secretBox: await crypto.subtle.importKey(
      "raw",
      buffer(await deriveBits(material, "secret-box", 256)),
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    ),
  };
}

/** Encrypts a short secret, returning base64url(iv || ciphertext+tag). */
export async function sealSecret(
  key: CryptoKey,
  plaintext: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: buffer(iv) },
      key,
      buffer(encoder.encode(plaintext)),
    ),
  );
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);
  return encodeBytes(combined);
}

/** Reverses {@link sealSecret}. Returns undefined when the value can't be read. */
export async function openSecret(
  key: CryptoKey,
  sealed: string,
): Promise<string | undefined> {
  try {
    const combined = decodeBytes(sealed);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buffer(combined.subarray(0, 12)) },
      key,
      buffer(combined.subarray(12)),
    );
    return decoder.decode(plaintext);
  } catch {
    return undefined;
  }
}

/** The non-sensitive suffix shown in the UI so a user can recognise a token. */
export function tokenHint(token: string): string {
  const trimmed = token.trim();
  return trimmed.length <= 4 ? "••••" : `••••${trimmed.slice(-4)}`;
}

async function sign(key: CryptoKey, value: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    buffer(encoder.encode(value)),
  );
  return encodeBytes(new Uint8Array(signature));
}

async function verify(
  key: CryptoKey,
  value: string,
  signature: string,
): Promise<boolean> {
  try {
    return await crypto.subtle.verify(
      "HMAC",
      key,
      buffer(decodeBytes(signature)),
      buffer(encoder.encode(value)),
    );
  } catch {
    return false;
  }
}

/** Signs an arbitrary JSON payload into a compact `body.signature` token. */
export async function signPayload(
  key: CryptoKey,
  payload: unknown,
): Promise<string> {
  const body = encodeJson(payload);
  return `${body}.${await sign(key, body)}`;
}

/** Verifies a token from {@link signPayload} and returns its payload. */
export async function verifyPayload<T>(
  key: CryptoKey,
  token: string,
): Promise<T | undefined> {
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return undefined;
  const body = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!(await verify(key, body, signature))) return undefined;
  return decodeJson<T>(body);
}
