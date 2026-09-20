import { useEffect, useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { KeyRound, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { eq, settingsCollection, type UserSettings } from "@/lib/collections";

function hintFor(token: string): string {
  return token.length <= 4 ? "••••" : `••••${token.slice(-4)}`;
}

export function SettingsForm({ userId }: { userId: string }) {
  const { data, isLoading } = useLiveQuery({
    query: (q) =>
      q
        .from({ settings: settingsCollection })
        .where(({ settings }) => eq(settings.user_id, userId))
        .findOne(),
  });
  const row: UserSettings | undefined = data;

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<
    { kind: "idle" | "saving" | "saved" | "error"; message?: string }
  >({ kind: "idle" });

  useEffect(() => {
    if (!row) return;
    setName(row.git_author_name ?? "");
    setEmail(row.git_author_email ?? "");
  }, [row?.git_author_name, row?.git_author_email]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!row) return;
    setStatus({ kind: "saving" });
    try {
      const transaction = settingsCollection.update(userId, (draft) => {
        draft.git_author_name = name.trim() || null;
        draft.git_author_email = email.trim() || null;
        if (token.trim()) {
          draft.github_token = token.trim();
          draft.has_token = true;
          draft.token_hint = hintFor(token.trim());
        }
      });
      await transaction.isPersisted.promise;
      setToken("");
      setStatus({ kind: "saved" });
    } catch (error) {
      setStatus({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Could not save settings.",
      });
    }
  }

  async function removeToken() {
    if (!row) return;
    setStatus({ kind: "saving" });
    try {
      const transaction = settingsCollection.update(userId, (draft) => {
        draft.github_token = null;
        draft.has_token = false;
        draft.token_hint = null;
      });
      await transaction.isPersisted.promise;
      setToken("");
      setStatus({ kind: "saved" });
    } catch (error) {
      setStatus({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Could not remove token.",
      });
    }
  }

  if (isLoading || !row) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
          <CardDescription>
            Loading your synced configuration&hellip;
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <form onSubmit={onSubmit}>
      <Card>
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
          <CardDescription>
            These values are used for sandboxes started from your requests.
            Secrets are encrypted before they are stored.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6">
          <div className="grid gap-2">
            <Label htmlFor="git-author-name">Git author name</Label>
            <Input
              id="git-author-name"
              value={name}
              maxLength={200}
              placeholder="Ada Lovelace"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="git-author-email">Git author email</Label>
            <Input
              id="git-author-email"
              type="email"
              value={email}
              maxLength={320}
              placeholder="ada@example.com"
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="github-token">GitHub personal access token</Label>
            <Input
              id="github-token"
              type="password"
              value={token}
              maxLength={255}
              autoComplete="off"
              placeholder={
                row.has_token
                  ? `Stored ${row.token_hint ?? ""} — enter a new token to replace it`
                  : "ghp_…"
              }
              onChange={(event) => setToken(event.target.value)}
            />
            <p className="text-muted-foreground text-sm">
              {row.has_token ? (
                <span className="inline-flex items-center gap-2">
                  <Badge variant="secondary">
                    <KeyRound /> Stored {row.token_hint ?? ""}
                  </Badge>
                  Leave the field blank to keep it, or enter a new token to
                  replace it.
                </span>
              ) : (
                "Used to clone private repositories, push branches, and open pull requests."
              )}
            </p>
          </div>
          {status.kind === "error" && (
            <p className="text-destructive text-sm">{status.message}</p>
          )}
          {status.kind === "saved" && (
            <p className="text-sm text-emerald-500">Configuration saved.</p>
          )}
        </CardContent>
        <CardFooter className="gap-2">
          <Button type="submit" disabled={status.kind === "saving"}>
            <Save />
            {status.kind === "saving" ? "Saving…" : "Save configuration"}
          </Button>
          {row.has_token && (
            <Button
              type="button"
              variant="outline"
              disabled={status.kind === "saving"}
              onClick={() => void removeToken()}
            >
              Remove token
            </Button>
          )}
        </CardFooter>
      </Card>
    </form>
  );
}
