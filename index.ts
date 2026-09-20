import {
  Client,
  Events,
  GatewayIntentBits,
  OAuth2Scopes,
  PermissionFlagsBits,
  type AnyThreadChannel,
  type Message,
} from "discord.js";
import { runOpenCode } from "./opencode";
import {
  computeConfigHash,
  destroySandbox,
  getOrCreateSandbox,
  queueDepth,
  runExclusive,
} from "./sandboxes";
import {
  clearSessionsForChannel,
  createSession,
  getSession,
  getTask,
  updateSessionOpenCodeId,
  updateTask,
} from "./store";
import type { SandboxTracing } from "./tracing";
import {
  handleTaskInteraction,
  registerTaskCommands,
  updateStatusMessage,
} from "./tasks";

const token = Bun.env.DISCORD_BOT_TOKEN;
const providerEnv: Record<string, string> = {};
const githubToken = Bun.env.GITHUB_TOKEN;

if (Bun.env.ANTHROPIC_API_KEY) {
  providerEnv.ANTHROPIC_API_KEY = Bun.env.ANTHROPIC_API_KEY;
}
if (Bun.env.FIREWORKS_API_KEY) {
  providerEnv.FIREWORKS_API_KEY = Bun.env.FIREWORKS_API_KEY;
}

if (!token) {
  throw new Error("DISCORD_BOT_TOKEN must be set in .env");
}
if (Object.keys(providerEnv).length === 0) {
  throw new Error(
    "ANTHROPIC_API_KEY or FIREWORKS_API_KEY must be set in .env",
  );
}

const model =
  Bun.env.OPENCODE_MODEL ??
  (providerEnv.FIREWORKS_API_KEY
    ? "fireworks-ai/accounts/fireworks/models/deepseek-v4p1-flash"
    : "anthropic/claude-sonnet-4-6");

// Sandboxes only emit traces when we know where Phoenix lives. The endpoint
// must be reachable from the sandbox: on Railway that is usually the private
// address `http://phoenix.railway.internal:6006`.
const phoenixEndpoint = Bun.env.PHOENIX_ENDPOINT;
const phoenixTracing: SandboxTracing | undefined = phoenixEndpoint
  ? { endpoint: phoenixEndpoint, apiKey: Bun.env.PHOENIX_API_KEY }
  : undefined;
const networkIsolation =
  Bun.env.SANDBOX_NETWORK_ISOLATION === "PRIVATE" ? "PRIVATE" : "ISOLATED";
const configHash = computeConfigHash(model, providerEnv, {
  tracing: phoenixTracing,
  networkIsolation,
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Discord bot logged in as ${readyClient.user.tag}`);
  await Promise.all(
    readyClient.guilds.cache.map((guild) =>
      registerTaskCommands(guild).catch((error) => {
        console.error(
          `Could not register commands for guild ${guild.id}:`,
          error instanceof Error ? error.message : String(error),
        );
      }),
    ),
  );
  console.log(
    `Invite it to a server: ${readyClient.generateInvite({
      scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands],
      permissions: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
      ],
    })}`,
  );
  if (phoenixTracing) {
    console.log(
      `OpenCode tracing enabled: sandboxes will export to ${phoenixTracing.endpoint} (networkIsolation=${networkIsolation}).`,
    );
  } else {
    console.log(
      "OpenCode tracing disabled. Set PHOENIX_ENDPOINT to a Phoenix URL reachable from Railway sandboxes to enable it.",
    );
  }
});

const inFlightThreads = new Set<string>();

client.on(Events.GuildCreate, (guild) => {
  void registerTaskCommands(guild).catch((error) => {
    console.error(
      `Could not register commands for guild ${guild.id}:`,
      error instanceof Error ? error.message : String(error),
    );
  });
});

client.on(Events.InteractionCreate, (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  void handleTaskInteraction(interaction, {
    client,
    providerEnv,
    configHash,
    githubToken,
    tracing: phoenixTracing,
    networkIsolation,
  }).catch(async (error) => {
    console.error("Could not handle Discord command:", error);
    const response = {
      content: "The command failed unexpectedly. Check the bot logs for details.",
      ephemeral: true,
    } as const;
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(response).catch(() => undefined);
    } else {
      await interaction.reply(response).catch(() => undefined);
    }
  });
});

client.on(Events.MessageCreate, (message) => {
  void routeMessage(message).catch((error) => {
    console.error("Could not route Discord message:", error);
  });
});

client.on(Events.Error, (error) => {
  console.error("Discord client error:", error);
});

await client.login(token);

async function routeMessage(message: Message): Promise<void> {
  if (message.author.bot || !client.user || !message.inGuild()) return;

  const botWasMentioned = message.mentions.users.has(client.user.id);
  const prompt = stripBotMention(message.content, client.user.id);

  if (message.channel.isThread()) {
    const session = getSession(message.channel.id);
    if (!session) {
      if (botWasMentioned) {
        await message.reply(
          "This thread isn't a bot session. Mention me in the parent channel to start one.",
        );
      }
      return;
    }

    if (!prompt) return;

    if (prompt.toLowerCase() === "reset") {
      updateSessionOpenCodeId(message.channel.id, null);
      await message.reply(
        "Session reset. Your next prompt will start a fresh OpenCode session in the same sandbox.",
      );
      return;
    }

    await runThreadPrompt({
      thread: message.channel,
      channelId: session.channelId,
      prompt,
      createdBy: session.createdBy ?? message.author.id,
    });
    return;
  }

  if (!botWasMentioned) return;

  const task = getTask(message.channel.id);
  if (!task || task.status === "archived") {
    await message.reply(
      "This channel isn't an active task channel. Use `/task` to create one.",
    );
    return;
  }

  if (!prompt) {
    await message.reply(
      "Mention me with a prompt, for example: `@umbrella investigate the failing test`.",
    );
    return;
  }

  if (prompt.toLowerCase() === "reset") {
    await destroySandbox(message.channel.id, task.sandboxId ?? undefined);
    clearSessionsForChannel(message.channel.id);
    const resetTask = updateTask(message.channel.id, {
      sandboxId: null,
      status: "provisioning",
    });
    if (resetTask) await updateStatusMessage(client, resetTask);
    await message.reply(
      "The sandbox was destroyed and all thread sessions were invalidated. A fresh sandbox will be built on the next prompt.",
    );
    return;
  }

  const thread = await message.startThread({
    name: createThreadName(prompt),
  });
  createSession({
    threadId: thread.id,
    channelId: message.channel.id,
    openCodeSessionId: null,
    createdBy: message.author.id,
    createdAt: Date.now(),
  });
  const taskWithSession = getTask(message.channel.id);
  if (taskWithSession) {
    await updateStatusMessage(client, taskWithSession);
  }

  await runThreadPrompt({
    thread,
    channelId: message.channel.id,
    prompt,
    createdBy: message.author.id,
  });
}

async function runThreadPrompt(options: {
  thread: AnyThreadChannel;
  channelId: string;
  prompt: string;
  createdBy: string;
}): Promise<void> {
  const { thread, channelId, prompt, createdBy } = options;
  if (inFlightThreads.has(thread.id)) {
    await thread.send(
      "I'm still working on the previous prompt in this thread.",
    );
    return;
  }

  inFlightThreads.add(thread.id);
  let statusMessage: Message | undefined;
  try {
    const depth = queueDepth(channelId);
    statusMessage = await thread.send(
      depth > 0
        ? `Queued behind ${depth} running session${depth === 1 ? "" : "s"}...`
        : "Working in OpenCode...",
    );

    await runExclusive(channelId, async () => {
      const task = getTask(channelId);
      if (!task || task.status === "archived") {
        await statusMessage?.edit(
          "This channel is no longer an active task channel.",
        );
        return;
      }

      const { sandbox, rebuilt } = await getOrCreateSandbox({
        task,
        providerEnv,
        configHash,
        githubToken,
        tracing: phoenixTracing,
        networkIsolation,
        onRebuild: async () => {
          clearSessionsForChannel(channelId);
          const parent = await client.channels.fetch(channelId).catch((error) => {
            console.error("Could not fetch sandbox rebuild channel:", error);
            return undefined;
          });
          if (parent?.isSendable()) {
            await parent
              .send(
                "The task sandbox was rebuilt. Previous thread sessions can't be resumed.",
              )
              .catch((error) => {
                console.error("Could not send sandbox rebuild notice:", error);
              });
          }
          const rebuiltTask = getTask(channelId);
          if (rebuiltTask) {
            await updateStatusMessage(client, rebuiltTask);
          }
        },
      });

      if (
        sandbox.id !== task.sandboxId ||
        task.configHash !== configHash
      ) {
        const readyTask = updateTask(channelId, {
          sandboxId: sandbox.id,
          configHash,
          status: "ready",
        });
        if (readyTask) await updateStatusMessage(client, readyTask);
      }

      let session = getSession(thread.id);
      if (rebuilt || !session) {
        createSession({
          threadId: thread.id,
          channelId,
          openCodeSessionId: null,
          createdBy,
          createdAt: Date.now(),
        });
        session = getSession(thread.id);
        const taskWithSession = getTask(channelId);
        if (taskWithSession) {
          await updateStatusMessage(client, taskWithSession);
        }
      }

      const storedSessionId = session?.openCodeSessionId ?? undefined;
      let step = 0;
      const response = await runOpenCode({
        sandbox,
        model,
        prompt,
        sessionId: storedSessionId,
        onProgress: async (event) => {
          if (event.type === "step_start") {
            step += 1;
            await statusMessage?.edit(
              step === 1
                ? "OpenCode is thinking..."
                : `OpenCode is continuing (step ${step})...`,
            );
          }

          if (event.type === "error") {
            await thread.send("✗ OpenCode reported an error.");
          }
        },
      });

      if (response.sessionId !== storedSessionId) {
        updateSessionOpenCodeId(thread.id, response.sessionId ?? null);
      }
      await statusMessage?.edit(truncateForDiscord(response.text));
    });
  } catch (error) {
    console.error("OpenCode run failed:", error);
    if (statusMessage) {
      await statusMessage
        .edit("OpenCode failed to finish. Check the bot logs for details.")
        .catch((editError) => {
          console.error("Could not edit failure status:", editError);
        });
    }
  } finally {
    inFlightThreads.delete(thread.id);
  }
}

function stripBotMention(content: string, botId: string): string {
  return content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
}

function createThreadName(prompt: string): string {
  const cleaned = prompt
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 80) || "OpenCode task";
}

function truncateForDiscord(value: string): string {
  const limit = 2_000;
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 15)}\n\n[truncated]`;
}