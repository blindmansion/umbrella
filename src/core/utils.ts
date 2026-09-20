import { createHash } from "node:crypto";

export function computeConfigHash(
  model: string,
  sandboxEnv: Record<string, string>,
  extra: Record<string, unknown> = {},
): string {
  return createHash("sha256")
    .update(JSON.stringify({ model, sandboxEnv, ...extra }))
    .digest("hex");
}

export function sanitizeText(value: string, secrets: string[] = []): string {
  let sanitized = value;
  for (const secret of secrets.filter(Boolean)) {
    sanitized = sanitized.replaceAll(secret, "[redacted]");
    sanitized = sanitized.replaceAll(
      encodeURIComponent(secret),
      "[redacted]",
    );
  }
  return sanitized
    .replace(
      /https:\/\/[^@\s]+@github\.com/gi,
      "https://[redacted]@github.com",
    )
    .replace(
      /(token|api[_-]?key|secret|password)(\s*[:=]\s*)\S+/gi,
      "$1$2[redacted]",
    )
    .slice(0, 1_000);
}

export function sanitizeError(error: unknown, secrets: string[] = []): string {
  return sanitizeText(
    error instanceof Error ? error.message : String(error),
    secrets,
  );
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
