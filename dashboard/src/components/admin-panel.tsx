import { useLiveQuery } from "@tanstack/react-db";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { settingsCollection, type UserSettings } from "@/lib/collections";

export function AdminPanel() {
  const { data } = useLiveQuery({
    query: (q) => q.from({ settings: settingsCollection }),
  });
  const rows: UserSettings[] = data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Server configuration</CardTitle>
        <CardDescription>
          As a server manager you can see every member&apos;s synced
          configuration. Secrets are never synced — only whether one is set.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No one has configured Umbrella yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-muted-foreground text-left">
                <tr className="border-b">
                  <th className="py-2 pr-4 font-medium">Member</th>
                  <th className="py-2 pr-4 font-medium">Git author</th>
                  <th className="py-2 pr-4 font-medium">Token</th>
                  <th className="py-2 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.user_id} className="border-b last:border-0">
                    <td className="py-2 pr-4">
                      {row.user_name ?? row.user_id}
                    </td>
                    <td className="py-2 pr-4">
                      {row.git_author_name ?? "—"}
                      {row.git_author_email ? (
                        <span className="text-muted-foreground">
                          {" "}
                          &lt;{row.git_author_email}&gt;
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-4">
                      {row.has_token ? (
                        <Badge variant="secondary">
                          {row.token_hint ?? "set"}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">none</span>
                      )}
                    </td>
                    <td className="text-muted-foreground py-2">
                      {new Date(row.updated_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
