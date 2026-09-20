function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeJson(value: unknown): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

export function decodeJson<T>(value: string): T | undefined {
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64Url(value))) as T;
  } catch {
    return undefined;
  }
}

export function encodeBytes(bytes: Uint8Array): string {
  return toBase64Url(bytes);
}

export function decodeBytes(value: string): Uint8Array {
  return fromBase64Url(value);
}
