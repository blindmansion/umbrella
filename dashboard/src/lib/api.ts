export type Me = {
  userId: string;
  userName: string | null;
  guildId: string;
  guildName: string | null;
  isAdmin: boolean;
};

export type SettingsInput = {
  gitAuthorName?: string | null;
  gitAuthorEmail?: string | null;
  githubToken?: string | null;
};

export async function fetchMe(): Promise<Me | undefined> {
  const response = await fetch("/api/me", { credentials: "same-origin" });
  if (response.status === 401) return undefined;
  if (!response.ok) throw new Error("Could not load your session.");
  return (await response.json()) as Me;
}

export async function logout(): Promise<void> {
  await fetch("/auth/logout", {
    method: "POST",
    credentials: "same-origin",
  });
  window.location.reload();
}

export async function saveSettings(
  input: SettingsInput,
): Promise<{ txid: number }> {
  const response = await fetch("/api/settings", {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error((await response.text()) || "Could not save your settings.");
  }
  return (await response.json()) as { txid: number };
}
