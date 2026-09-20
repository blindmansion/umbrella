import type { SandboxNetworkIsolation } from "railway";
import { computeConfigHash } from "./sandbox/manager";
import type { SandboxTracing } from "./tracing/phoenix";

export type AppConfig = {
  token: string;
  model: string;
  sandboxEnv: Record<string, string>;
  configHash: string;
  githubToken?: string;
  tracing?: SandboxTracing;
  networkIsolation: SandboxNetworkIsolation;
};

export function loadConfig(): AppConfig {
  const token = Bun.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN must be set in .env");
  }

  const providerEnv: Record<string, string> = {};
  if (Bun.env.ANTHROPIC_API_KEY) {
    providerEnv.ANTHROPIC_API_KEY = Bun.env.ANTHROPIC_API_KEY;
  }
  if (Bun.env.FIREWORKS_API_KEY) {
    providerEnv.FIREWORKS_API_KEY = Bun.env.FIREWORKS_API_KEY;
  }
  if (Object.keys(providerEnv).length === 0) {
    throw new Error(
      "ANTHROPIC_API_KEY or FIREWORKS_API_KEY must be set in .env",
    );
  }

  const githubToken = Bun.env.GITHUB_TOKEN;
  const sandboxEnv: Record<string, string> = { ...providerEnv };
  if (githubToken) {
    sandboxEnv.GITHUB_TOKEN = githubToken;
    sandboxEnv.GH_TOKEN = githubToken;
  }
  if (Bun.env.GIT_AUTHOR_NAME) {
    sandboxEnv.GIT_AUTHOR_NAME = Bun.env.GIT_AUTHOR_NAME;
    sandboxEnv.GIT_COMMITTER_NAME = Bun.env.GIT_AUTHOR_NAME;
  }
  if (Bun.env.GIT_AUTHOR_EMAIL) {
    sandboxEnv.GIT_AUTHOR_EMAIL = Bun.env.GIT_AUTHOR_EMAIL;
    sandboxEnv.GIT_COMMITTER_EMAIL = Bun.env.GIT_AUTHOR_EMAIL;
  }

  const model =
    Bun.env.OPENCODE_MODEL ??
    (providerEnv.FIREWORKS_API_KEY
      ? "fireworks-ai/accounts/fireworks/models/deepseek-v4p1-flash"
      : "anthropic/claude-sonnet-4-6");
  const tracing = Bun.env.PHOENIX_ENDPOINT
    ? {
        endpoint: Bun.env.PHOENIX_ENDPOINT,
        apiKey: Bun.env.PHOENIX_API_KEY,
      }
    : undefined;
  const networkIsolation =
    Bun.env.SANDBOX_NETWORK_ISOLATION === "PRIVATE"
      ? "PRIVATE"
      : "ISOLATED";

  return {
    token,
    model,
    sandboxEnv,
    configHash: computeConfigHash(model, sandboxEnv, {
      tracing,
      networkIsolation,
    }),
    githubToken,
    tracing,
    networkIsolation,
  };
}
