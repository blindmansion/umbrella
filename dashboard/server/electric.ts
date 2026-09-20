import { ELECTRIC_PROTOCOL_QUERY_PARAMS } from "@electric-sql/client";

import type { SessionPayload } from "../../shared/session";
import { env } from "./env";

const COLUMNS =
  "user_id,user_name,git_author_name,git_author_email,token_hint,has_token,updated_at";

/**
 * Authorizing proxy in front of Electric, following the documented proxy-auth
 * pattern. The table, columns, and row filter are set server-side so a client
 * can never widen its own access. The Electric secret never reaches the client.
 */
export async function proxyElectric(
  request: Request,
  session: SessionPayload,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  const origin = new URL(`${env.electricUrl}/v1/shape`);

  for (const key of requestUrl.searchParams.keys()) {
    if (!ELECTRIC_PROTOCOL_QUERY_PARAMS.includes(key)) continue;
    for (const value of requestUrl.searchParams.getAll(key)) {
      origin.searchParams.append(key, value);
    }
  }

  origin.searchParams.set("table", "user_settings");
  origin.searchParams.set("columns", COLUMNS);
  if (!session.a) {
    origin.searchParams.set("where", "user_id = $1");
    origin.searchParams.set("params[1]", session.u);
  }
  if (env.electricSecret) {
    origin.searchParams.set("secret", env.electricSecret);
  }

  const method = request.method === "POST" ? "POST" : "GET";
  const body = method === "POST" ? await request.text() : undefined;
  const upstream = await fetch(origin, {
    method,
    body,
    headers: body ? { "content-type": "application/json" } : undefined,
  }).catch(
    () =>
      new Response("Electric is unavailable", {
        status: 502,
        statusText: "Bad Gateway",
      }),
  );

  const headers = new Headers(upstream.headers);
  // fetch decompresses the body but leaves these headers, which breaks the
  // browser's decoding of the streamed response.
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("Vary", "Cookie");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}
