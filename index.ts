import {
  Client,
  Events,
  GatewayIntentBits,
  OAuth2Scopes,
  PermissionFlagsBits,
} from "discord.js";
import { mkdir, rm } from "node:fs/promises";
import { Sandbox } from "railway";

const token = Bun.env.DISCORD_BOT_TOKEN;
const providerEnv: Record<string, string> = {};

if (Bun.env.ANTHROPIC_API_KEY) {
  providerEnv.ANTHROPIC_API_KEY = Bun.env.ANTHROPIC_API_KEY;
}
if (Bun.env.OPENROUTER_API_KEY) {
  providerEnv.OPENROUTER_API_KEY = Bun.env.OPENROUTER_API_KEY;
}

if (!token) {
  throw new Error("DISCORD_BOT_TOKEN must be set in .env");
}
if (Object.keys(providerEnv).length === 0) {
  throw new Error(
    "ANTHROPIC_API_KEY or OPENROUTER_API_KEY must be set in .env",
  );
}

const model =
  Bun.env.OPENCODE_MODEL ??
  (providerEnv.OPENROUTER_API_KEY
    ? "openrouter/qwen/qwen3-coder"
    : "anthropic/claude-sonnet-4-6");
const dataDirectory = `${process.cwd()}/data`;
const sessionStatePath = `${dataDirectory}/session.json`;

type SessionState = {
  sandboxId: string;
  openCodeSessionId?: string;
};

let sessionState = await loadSessionState();
let activeSandbox: Sandbox | undefined;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Discord bot logged in as ${readyClient.user.tag}`);
  console.log(
    `Invite it to a server: ${readyClient.generateInvite({
      scopes: [OAuth2Scopes.Bot],
      permissions: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    })}`,
  );
});

let busy = false;

client.on(Events.MessageCreate, async (message) => {
  if (
    message.author.bot ||
    !client.user ||
    !message.mentions.users.has(client.user.id)
  ) {
    return;
  }

  const prompt = message.content
    .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
    .trim();

  if (!prompt) {
    await message.reply("Mention me with a prompt, for example: `@umbrella say hi`");
    return;
  }

  if (busy) {
    await message.reply("I'm already working on a prompt. Try again shortly.");
    return;
  }

  busy = true;
  const isReset = prompt.toLowerCase() === "reset";
  const reply = await message.reply(
    isReset ? "Resetting the OpenCode session..." : "Working in OpenCode...",
  );

  try {
    if (isReset) {
      await resetSession();
      await reply.edit("Session reset. Your next prompt will start a new one.");
      return;
    }

    const response = await runOpenCode(prompt);
    await reply.edit(truncateForDiscord(response));
  } catch (error) {
    console.error("OpenCode run failed:", error);
    await reply.edit("OpenCode failed to finish. Check the bot logs for details.");
  } finally {
    busy = false;
  }
});

client.on(Events.Error, (error) => {
  console.error("Discord client error:", error);
});

await client.login(token);

async function runOpenCode(prompt: string) {
  const sandbox = await getOrCreateSandbox();
  const textParts: string[] = [];
  const stderrParts: string[] = [];
  let stdoutBuffer = "";
  let discoveredSessionId: string | undefined;
  const sessionFlag = sessionState?.openCodeSessionId
    ? ` --session ${shellQuote(sessionState.openCodeSessionId)}`
    : "";

  await sandbox.files.mkdir("/root/workspace");
  await sandbox.files.write("/tmp/opencode-prompt.txt", prompt);

  const handle = sandbox.exec(
    [
      "bash -lc",
      shellQuote(
        `cd /root/workspace && prompt="$(cat /tmp/opencode-prompt.txt)" && exec opencode run --auto --format json --model ${shellQuote(model)}${sessionFlag} -- "$prompt"`,
      ),
    ].join(" "),
    {
      timeoutSec: 900,
      onStdout: (chunk) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          discoveredSessionId =
            collectOpenCodeEvent(line, textParts) ?? discoveredSessionId;
        }
      },
      onStderr: (chunk) => stderrParts.push(chunk),
    },
  );

  console.log(`OpenCode exec session ${await handle.sessionName}`);
  const result = await handle;

  if (stdoutBuffer.trim()) {
    discoveredSessionId =
      collectOpenCodeEvent(stdoutBuffer, textParts) ?? discoveredSessionId;
  }
  if (result.timedOut) throw new Error("OpenCode timed out");
  if (result.exitCode !== 0) {
    throw new Error(
      stderrParts.join("").trim() ||
        `OpenCode exited with code ${result.exitCode}`,
    );
  }

  if (discoveredSessionId !== sessionState?.openCodeSessionId) {
    await saveSessionState({
      sandboxId: sandbox.id,
      openCodeSessionId: discoveredSessionId,
    });
  }

  const response = textParts.join("").trim();
  if (!response) throw new Error("OpenCode returned no text");
  return response;
}

function collectOpenCodeEvent(line: string, textParts: string[]) {
  if (!line.trim()) return undefined;

  try {
    const event = JSON.parse(line) as {
      type?: string;
      text?: string;
      part?: { text?: string };
      sessionID?: string;
    };
    if (event.type === "text") {
      const text = event.part?.text ?? event.text;
      if (text) textParts.push(text);
    }
    return event.sessionID;
  } catch {
    console.warn("Ignoring non-JSON OpenCode output:", line);
    return undefined;
  }
}

async function getOrCreateSandbox() {
  if (activeSandbox) return activeSandbox;

  if (sessionState) {
    try {
      activeSandbox = await Sandbox.connect(sessionState.sandboxId);
      console.log(`Reconnected to Railway sandbox ${activeSandbox.id}`);
      return activeSandbox;
    } catch (error) {
      console.warn(
        `Could not reconnect to sandbox ${sessionState.sandboxId}; creating a new one:`,
        error,
      );
      await clearSessionState();
    }
  }

  activeSandbox = await Sandbox.create({
    idleTimeoutMinutes: 60,
    env: providerEnv,
  });
  await saveSessionState({ sandboxId: activeSandbox.id });
  console.log(`Created persistent Railway sandbox ${activeSandbox.id}`);
  return activeSandbox;
}

async function resetSession() {
  let sandbox = activeSandbox;

  if (!sandbox && sessionState) {
    sandbox = await Sandbox.connect(sessionState.sandboxId).catch(() => undefined);
  }

  if (sandbox) {
    await sandbox.destroy().catch((error) => {
      console.warn(`Could not destroy sandbox ${sandbox.id}:`, error);
    });
  }

  activeSandbox = undefined;
  await clearSessionState();
}

async function loadSessionState(): Promise<SessionState | undefined> {
  const file = Bun.file(sessionStatePath);
  if (!(await file.exists())) return undefined;

  try {
    const value = (await file.json()) as Partial<SessionState>;
    if (typeof value.sandboxId !== "string") {
      throw new Error("Missing sandboxId");
    }
    return {
      sandboxId: value.sandboxId,
      openCodeSessionId:
        typeof value.openCodeSessionId === "string"
          ? value.openCodeSessionId
          : undefined,
    };
  } catch (error) {
    console.warn("Ignoring invalid saved session state:", error);
    return undefined;
  }
}

async function saveSessionState(value: SessionState) {
  await mkdir(dataDirectory, { recursive: true });
  await Bun.write(sessionStatePath, `${JSON.stringify(value, null, 2)}\n`);
  sessionState = value;
}

async function clearSessionState() {
  await rm(sessionStatePath, { force: true });
  sessionState = undefined;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function truncateForDiscord(value: string) {
  const limit = 2_000;
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 15)}\n\n[truncated]`;
}