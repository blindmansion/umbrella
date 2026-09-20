import { useEffect, useState } from "react";
import { LogOut, ShieldCheck, Umbrella } from "lucide-react";

import { AdminPanel } from "@/components/admin-panel";
import { SettingsForm } from "@/components/settings-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchMe, logout, type Me } from "@/lib/api";

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);

  useEffect(() => {
    fetchMe()
      .then((value) => setMe(value ?? null))
      .catch(() => setMe(null));
  }, []);

  if (me === undefined) {
    return (
      <main className="mx-auto flex min-h-svh w-full max-w-3xl flex-col gap-6 p-6">
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-64 w-full" />
      </main>
    );
  }

  if (me === null) {
    return (
      <main className="mx-auto flex min-h-svh w-full max-w-xl items-center p-6">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>This session isn&apos;t signed in</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-sm">
            Dashboard links are single-use and expire quickly. Run
            <code className="bg-muted mx-1 rounded px-1 py-0.5">
              /configure
            </code>
            in Discord to get a fresh one.
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-3xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Umbrella className="size-8" />
          <div>
            <h1 className="text-xl font-semibold">Umbrella</h1>
            <p className="text-muted-foreground text-sm">
              {me.userName ?? me.userId}
              {me.guildName ? ` in ${me.guildName}` : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {me.isAdmin && (
            <Badge variant="secondary">
              <ShieldCheck /> Server manager
            </Badge>
          )}
          <Button variant="outline" size="sm" onClick={() => void logout()}>
            <LogOut /> Sign out
          </Button>
        </div>
      </header>

      <SettingsForm userId={me.userId} />
      {me.isAdmin && <AdminPanel />}
    </main>
  );
}
