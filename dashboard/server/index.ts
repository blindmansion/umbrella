import { join, normalize } from "node:path";

import {
  clearSessionCookie,
  exchangeMagicLink,
  initAuth,
  readSession,
  sessionCookie,
  sessionForPayload,
} from "./auth";
import { ensureSchema, ensureUserRow, pool } from "./db";
import { proxyElectric } from "./electric";
import { assertEnv, env } from "./env";
import { saveSettings } from "./settings";

assertEnv();
await initAuth();
await ensureSchema();

const DIST = join(import.meta.dir, "..", "dist");

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" },
  });
}

async function handleMagic(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) return text("This link is missing its token.", 400);
  const session = await exchangeMagicLink(token);
  if (!session) {
    return text(
      "This dashboard link is invalid, expired, or has already been used. Run /configure again to get a new one.",
      401,
    );
  }
  await ensureUserRow(session.u, session.un);
  const cookie = sessionCookie(await sessionForPayload(session));
  return new Response(null, {
    status: 302,
    headers: { location: "/", "set-cookie": cookie, ...SECURITY_HEADERS },
  });
}

function handleLogout(): Response {
  return new Response(null, {
    status: 204,
    headers: { "set-cookie": clearSessionCookie(), ...SECURITY_HEADERS },
  });
}

async function handleMe(request: Request): Promise<Response> {
  const session = await readSession(request);
  if (!session) return text("Not signed in.", 401);
  return Response.json(
    {
      userId: session.u,
      userName: session.un,
      guildId: session.g,
      guildName: session.gn,
      isAdmin: session.a,
    },
    { headers: SECURITY_HEADERS },
  );
}

async function handleSettings(request: Request): Promise<Response> {
  const session = await readSession(request);
  if (!session) return text("Not signed in.", 401);
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return text("Expected a JSON body.", 400);
  }
  if (typeof input !== "object" || input === null) {
    return text("Expected a JSON object.", 400);
  }
  const result = await saveSettings(
    session,
    input as Record<string, unknown>,
  );
  if (!result.ok) return text(result.error, 400);
  return Response.json({ txid: result.txid }, { headers: SECURITY_HEADERS });
}

async function handleElectric(request: Request): Promise<Response> {
  const session = await readSession(request);
  if (!session) return text("Not signed in.", 401);
  return proxyElectric(request, session);
}

async function serveStatic(pathname: string): Promise<Response> {
  if (pathname !== "/") {
    const relative = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    const candidate = join(DIST, relative);
    if (candidate.startsWith(DIST)) {
      const file = Bun.file(candidate);
      if (await file.exists()) {
        return new Response(file, { headers: SECURITY_HEADERS });
      }
    }
  }
  const index = Bun.file(join(DIST, "index.html"));
  if (!(await index.exists())) {
    return text("The dashboard has not been built yet.", 500);
  }
  return new Response(index, {
    headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" },
  });
}

const server = Bun.serve({
  port: env.port,
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/health") {
        return Response.json({ status: "ok" }, { headers: SECURITY_HEADERS });
      }
      if (url.pathname === "/auth/magic") return await handleMagic(request);
      if (url.pathname === "/auth/logout") {
        if (request.method !== "POST") return text("Method not allowed.", 405);
        return handleLogout();
      }
      if (url.pathname === "/api/me") return await handleMe(request);
      if (url.pathname === "/api/settings") {
        if (request.method !== "PUT") return text("Method not allowed.", 405);
        return await handleSettings(request);
      }
      if (url.pathname === "/api/electric") return await handleElectric(request);
      return await serveStatic(url.pathname);
    } catch (error) {
      console.error("Dashboard request failed:", error);
      return text("Internal server error.", 500);
    }
  },
});

console.log(`Umbrella dashboard listening on http://localhost:${server.port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.stop().then(() => pool.end());
  });
}
