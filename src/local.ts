import { TerminalChat } from "./adapters/local/chat";
import { createLocalSandboxProvider } from "./adapters/local/sandboxes";
import { createMemoryStore } from "./adapters/local/store";
import { createGitHubClient } from "./adapters/github/client";
import { createUmbrella } from "./core/umbrella";
import { computeConfigHash } from "./core/utils";
import type { IncomingMessage } from "./core/ports";

const sandboxEnv: Record<string, string> = {};
for (const key of ["ANTHROPIC_API_KEY", "FIREWORKS_API_KEY", "GITHUB_TOKEN"]) {
  const value = Bun.env[key];
  if (value) sandboxEnv[key] = value;
}
if (!sandboxEnv.ANTHROPIC_API_KEY && !sandboxEnv.FIREWORKS_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY or FIREWORKS_API_KEY must be set");
}
const model =
  Bun.env.OPENCODE_MODEL ??
  (sandboxEnv.FIREWORKS_API_KEY
    ? "fireworks-ai/accounts/fireworks/models/deepseek-v4p1-flash"
    : "anthropic/claude-sonnet-4-6");
const store = createMemoryStore();
const chat = new TerminalChat();
const umbrella = createUmbrella({
  store,
  chat,
  sandboxes: createLocalSandboxProvider(),
  github: createGitHubClient(Bun.env.GITHUB_TOKEN),
  config: {
    model,
    sandboxEnv,
    githubToken: Bun.env.GITHUB_TOKEN,
    configHash: computeConfigHash(model, sandboxEnv),
  },
});

if (Bun.env.LOCAL_REPO) {
  await umbrella.onCommand({
    type: "repo",
    guildId: "local",
    action: "set",
    repo: Bun.env.LOCAL_REPO,
  });
}

console.log(
  "Umbrella local mode. Type `@umbrella <request>`; set LOCAL_REPO=owner/name or use `/repo set owner/name`.",
);
let sequence = 0;
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("/repo ")) {
      const [, action, repo] = line.split(/\s+/, 3);
      const result = await umbrella.onCommand({
        type: "repo",
        guildId: "local",
        action:
          action === "set" || action === "clear" ? action : "show",
        repo,
      });
      console.log(result.message);
      continue;
    }
    const botMentioned = /@umbrella\b/i.test(line);
    const message: IncomingMessage = {
      id: `input-${++sequence}`,
      guildId: "local",
      guildName: "local",
      channelId: "local",
      authorId: "local-user",
      authorName: "you",
      text: line.replace(/@umbrella\b/gi, "").trim(),
      botMentioned,
      isReplyToBot: false,
    };
    await umbrella.onMessage(message);
    chat.accept(message);
  }
}
