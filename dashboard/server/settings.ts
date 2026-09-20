import { sealSecret, tokenHint } from "../../shared/crypto";
import type { SessionPayload } from "../../shared/session";
import { secretBox } from "./auth";
import { withTxid } from "./db";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME = 200;
const MAX_EMAIL = 320;
const MAX_TOKEN = 255;

export type SettingsInput = {
  gitAuthorName?: unknown;
  gitAuthorEmail?: unknown;
  githubToken?: unknown;
};

export type SettingsResult =
  | { ok: true; txid: number }
  | { ok: false; error: string };

type CurrentRow = {
  git_author_name: string | null;
  git_author_email: string | null;
  token_hint: string | null;
  has_token: boolean;
};

function clean(value: unknown, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length > max) return undefined;
  return trimmed.length === 0 ? null : trimmed;
}

/** Validates and persists a user's dashboard configuration. */
export async function saveSettings(
  session: SessionPayload,
  input: SettingsInput,
): Promise<SettingsResult> {
  const gitAuthorName = clean(input.gitAuthorName, MAX_NAME);
  if (input.gitAuthorName !== undefined && gitAuthorName === undefined) {
    return { ok: false, error: "That git author name isn't valid." };
  }
  const gitAuthorEmail = clean(input.gitAuthorEmail, MAX_EMAIL);
  if (input.gitAuthorEmail !== undefined && gitAuthorEmail === undefined) {
    return { ok: false, error: "That git author email isn't valid." };
  }
  if (gitAuthorEmail && !EMAIL.test(gitAuthorEmail)) {
    return { ok: false, error: "Enter a valid email address." };
  }

  let token: string | null | undefined;
  if (input.githubToken !== undefined) {
    if (input.githubToken === null) {
      token = null;
    } else if (typeof input.githubToken !== "string") {
      return { ok: false, error: "That GitHub token isn't valid." };
    } else {
      const trimmed = input.githubToken.trim();
      if (trimmed.length === 0) {
        token = null;
      } else if (trimmed.length > MAX_TOKEN || /\s/.test(trimmed)) {
        return { ok: false, error: "That GitHub token isn't valid." };
      } else {
        token = trimmed;
      }
    }
  }

  const now = Date.now();
  const sealed = token ? await sealSecret(secretBox(), token) : null;
  const hint = token ? tokenHint(token) : null;

  const { txid } = await withTxid(async (client) => {
    const { rows } = await client.query<CurrentRow>(
      "SELECT git_author_name, git_author_email, token_hint, has_token FROM user_settings WHERE user_id = $1 FOR UPDATE",
      [session.u],
    );
    const current = rows[0];
    const nextName =
      gitAuthorName !== undefined
        ? gitAuthorName
        : current?.git_author_name ?? null;
    const nextEmail =
      gitAuthorEmail !== undefined
        ? gitAuthorEmail
        : current?.git_author_email ?? null;
    const nextHint = token !== undefined ? hint : current?.token_hint ?? null;
    const nextHasToken =
      token !== undefined ? token !== null : current?.has_token ?? false;

    await client.query(
      `INSERT INTO user_settings (
        user_id, user_name, git_author_name, git_author_email, token_hint,
        has_token, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
      ON CONFLICT (user_id) DO UPDATE SET
        user_name = EXCLUDED.user_name,
        git_author_name = EXCLUDED.git_author_name,
        git_author_email = EXCLUDED.git_author_email,
        token_hint = EXCLUDED.token_hint,
        has_token = EXCLUDED.has_token,
        updated_at = EXCLUDED.updated_at`,
      [
        session.u,
        session.un,
        nextName,
        nextEmail,
        nextHint,
        nextHasToken,
        now,
      ],
    );

    if (token !== undefined) {
      if (sealed === null) {
        await client.query("DELETE FROM user_secrets WHERE user_id = $1", [
          session.u,
        ]);
      } else {
        await client.query(
          `INSERT INTO user_secrets (user_id, encrypted_token, updated_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id) DO UPDATE SET
             encrypted_token = EXCLUDED.encrypted_token,
             updated_at = EXCLUDED.updated_at`,
          [session.u, sealed, now],
        );
      }
    }
  });

  return { ok: true, txid };
}
