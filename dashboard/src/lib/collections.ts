import { createCollection, eq } from "@tanstack/react-db";
import { electricCollectionOptions } from "@tanstack/electric-db-collection";

import { saveSettings, type SettingsInput } from "./api";

export type UserSettings = {
  user_id: string;
  user_name: string | null;
  git_author_name: string | null;
  git_author_email: string | null;
  token_hint: string | null;
  has_token: boolean;
  updated_at: number;
  /** Client-only field carrying a new token through a mutation. Not synced. */
  github_token?: string | null;
};

function toInput(changes: Partial<UserSettings>): SettingsInput {
  const input: SettingsInput = {};
  if ("git_author_name" in changes) {
    input.gitAuthorName = changes.git_author_name ?? null;
  }
  if ("git_author_email" in changes) {
    input.gitAuthorEmail = changes.git_author_email ?? null;
  }
  if ("github_token" in changes) {
    input.githubToken = changes.github_token ?? null;
  }
  return input;
}

async function persist(changes: Partial<UserSettings>) {
  const { txid } = await saveSettings(toInput(changes));
  return { txid };
}

/**
 * Live view of `user_settings`. Electric syncs rows through the dashboard's
 * authorizing proxy, and TanStack DB persists writes by returning the
 * PostgreSQL txid so the optimistic row is reconciled with the sync stream.
 */
export const settingsCollection = createCollection(
  electricCollectionOptions<UserSettings>({
    id: "user_settings",
    shapeOptions: { url: "/api/electric" },
    getKey: (row) => row.user_id,
    onInsert: async ({ transaction }) =>
      persist(transaction.mutations[0]?.modified ?? {}),
    onUpdate: async ({ transaction }) =>
      persist(transaction.mutations[0]?.changes ?? {}),
  }),
);

export { eq };
