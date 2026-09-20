import {
  Client,
  ChannelType,
  Events,
  GatewayIntentBits,
  OAuth2Scopes,
  PermissionFlagsBits,
  type AnyThreadChannel,
  type Message,
  type TextChannel,
} from "discord.js";
import { loadConfig } from "../config";
import { buildPendingPrompt } from "../intent/backlog";
import {
  classifyMessage,
  resolveIntentAction,
  type ConversationTurn,
  type IntentAction,
  type IntentSurface,
} from "../intent/classifier";
import { runOpenCode } from "../opencode/runner";
import {
  destroySandbox,
  getOrCreateSandbox,
} from "../sandbox/manager";
import { queueDepth, runExclusive } from "../sandbox/queue";
import {
  clearSessionsForChannel,
  createSession,
  getGuildRepo,
  getSession,
  getTask,
  initializeStore,
  updateSessionOpenCodeId,
  updateTask,
} from "../store";
import {
  closeTaskWorkflow,
  createTaskChannelForRepo,
  createTaskChannelFromReference,
  handleTaskInteraction,
  registerTaskCommands,
  updateStatusMessage,
} from "../tasks/commands";
import { findGitHubReference, type GitHubReference } from "../tasks/github";
import { splitForDiscord } from "./output";

const {
  token,
  model,
  sandboxEnv,
  configHash,
  githubToken,
  tracing: phoenixTracing,
  networkIsolation,
  intent,
} = loadConfig();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const taskContext = {
  client,
  sandboxEnv,
  configHash,
  githubToken,
  tracing: phoenixTracing,
  networkIsolation,
};

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
  if (intent) {
    console.log(
      `Intent classification enabled via TypeSafe ${intent.model} (confidence threshold=${intent.confidenceThreshold}).`,
    );
  } else {
    console.log(
      "Intent classification disabled. Set TYPESAFE_API_KEY to let the bot infer intent without mentions.",
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
  void handleTaskInteraction(interaction, taskContext).catch(async (error) => {
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

await initializeStore();
await client.login(token);

async function routeMessage(message: Message): Promise<void> {
  if (message.author.bot || !client.user || !message.inGuild()) return;

  const botWasMentioned = message.mentions.users.has(client.user.id);
  const prompt = stripBotMention(message.content, client.user.id);

  if (message.channel.isThread()) {
    await routeThreadMessage(message, { botWasMentioned, prompt });
    return;
  }

  await routeChannelMessage(message, { botWasMentioned, prompt });
}

async function routeThreadMessage(
  message: Message,
  options: { botWasMentioned: boolean; prompt: string },
): Promise<void> {
  const { botWasMentioned } = options;
  const thread = message.channel;
  if (!thread.isThread()) return;

  const session = await getSession(thread.id);
  if (!session) {
    if (botWasMentioned) {
      await message.reply(
        "This thread isn't a bot session. Mention me in the parent channel to start one.",
      );
    }
    return;
  }

  const recentTurns = await fetchRecentTurns(message);
  const action = await classifyAction(message, {
    surface: "thread",
    taskActive: true,
    hasSession: true,
    botMentioned: botWasMentioned,
    recentTurns,
  });
  if (!action) return;

  if (action === "reset") {
    await updateSessionOpenCodeId(thread.id, null);
    await message.reply(
      "Session reset. Your next prompt will start a fresh OpenCode session in the same sandbox.",
    );
    return;
  }

  // A session thread is already a task, so a request for new work continues it.
  if (action !== "chat" && action !== "create_task") return;

  // Include messages the bot stayed silent on so OpenCode sees the whole
  // exchange, and so a bare mention means "respond to what I just said".
  const pendingPrompt = buildPendingPrompt(recentTurns, latestTurn(message));
  if (!pendingPrompt) {
    if (botWasMentioned) {
      await message.reply(
        "Mention me with a prompt, for example: `@umbrella investigate the failing test`.",
      );
    }
    return;
  }

  await runThreadPrompt({
    thread,
    channelId: session.channelId,
    prompt: pendingPrompt,
    createdBy: session.createdBy ?? message.author.id,
  });
}

async function routeChannelMessage(
  message: Message,
  options: { botWasMentioned: boolean; prompt: string },
): Promise<void> {
  const { botWasMentioned, prompt } = options;
  const channelId = message.channel.id;
  const task = await getTask(channelId);
  const taskActive = Boolean(task && task.status !== "archived");
  const reference = findGitHubReference(prompt || message.content);

  const recentTurns =
    intent || taskActive ? await fetchRecentTurns(message) : [];
  const action = await classifyAction(message, {
    surface: taskActive ? "task_channel" : "other",
    taskActive,
    hasSession: false,
    botMentioned: botWasMentioned,
    recentTurns,
  });

  if (!taskActive || !task) {
    await routeUntrackedChannel(message, {
      action,
      reference,
      botWasMentioned,
      prompt,
    });
    return;
  }

  if (action === "close") {
    await message.reply("Closing this task and destroying its sandbox...");
    await closeTaskWorkflow({ client, channelId });
    return;
  }

  if (action === "create_task" && reference) {
    await createTaskFromMessage(message, reference);
    return;
  }

  if (action === "reset") {
    await destroySandbox(channelId, task.sandboxId ?? undefined);
    await clearSessionsForChannel(channelId);
    const resetTask = await updateTask(channelId, {
      sandboxId: null,
      status: "provisioning",
    });
    if (resetTask) await updateStatusMessage(client, resetTask);
    await message.reply(
      "The sandbox was destroyed and all thread sessions were invalidated. A fresh sandbox will be built on the next prompt.",
    );
    return;
  }

  // Without a GitHub reference there is no new task to create, so a request
  // for work in an existing task channel starts a session here.
  if (action !== "chat" && action !== "create_task") return;

  // A bare mention means "respond to what I just said".
  const chatPrompt =
    prompt || buildPendingPrompt(recentTurns, latestTurn(message));
  if (!chatPrompt) {
    await message.reply(
      "Mention me with a prompt, for example: `@umbrella investigate the failing test`.",
    );
    return;
  }

  const thread = await message.startThread({
    name: createThreadName(chatPrompt),
  });
  await createSession({
    threadId: thread.id,
    channelId,
    openCodeSessionId: null,
    createdBy: message.author.id,
    createdAt: Date.now(),
  });
  const taskWithSession = await getTask(channelId);
  if (taskWithSession) {
    await updateStatusMessage(client, taskWithSession);
  }

  await runThreadPrompt({
    thread,
    channelId,
    prompt: chatPrompt,
    createdBy: message.author.id,
  });
}

async function routeUntrackedChannel(
  message: Message,
  options: {
    action: IntentAction | undefined;
    reference: GitHubReference | undefined;
    botWasMentioned: boolean;
    prompt: string;
  },
): Promise<void> {
  const { action, reference, botWasMentioned, prompt } = options;
  if (reference && (action === "create_task" || botWasMentioned)) {
    await createTaskFromMessage(message, reference);
    return;
  }

  const wantsRepoTask =
    !reference &&
    prompt.length > 0 &&
    (action === "create_task" || action === "chat");
  if (wantsRepoTask && message.guild) {
    const configured = await getGuildRepo(message.guild.id);
    if (configured) {
      await createRepoTaskFromMessage(message, configured.repo, prompt);
      return;
    }
    if (botWasMentioned || action === "create_task") {
      await message.reply(
        "This server doesn't have a task repository yet. An admin can set one with `/repo set owner/name`, or share a GitHub issue or pull request URL.",
      );
      return;
    }
  }

  if (botWasMentioned) {
    await message.reply(
      "This channel isn't an active task channel. Share a GitHub issue or pull request URL and I'll set one up, or ask an admin to set a default repository with `/repo set owner/name`.",
    );
  }
}

async function createTaskFromMessage(
  message: Message,
  reference: GitHubReference,
): Promise<void> {
  const guild = message.guild;
  if (!guild) return;

  const notice = await message
    .reply(
      `Setting up a task for ${reference.owner}/${reference.name}#${reference.number}...`,
    )
    .catch((error) => {
      console.error("Could not acknowledge task creation:", error);
      return undefined;
    });

  try {
    const { channel, provisioningError } = await createTaskChannelFromReference({
      guild,
      actorTag: message.author.tag,
      reference,
      kind: reference.urlKind === "pull" ? "review" : "feature",
      context: taskContext,
    });
    const summary = provisioningError
      ? `Task channel created at ${channel}, but sandbox provisioning failed: ${provisioningError}`
      : `Task ready: ${channel}`;
    if (notice) {
      await notice.edit(summary);
    } else if ("send" in message.channel) {
      await message.channel.send(summary).catch(() => undefined);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (notice) {
      await notice.edit(`Could not create the task: ${detail}`);
    }
  }
}

async function createRepoTaskFromMessage(
  message: Message,
  repo: string,
  prompt: string,
): Promise<void> {
  const guild = message.guild;
  if (!guild) return;

  const notice = await message
    .reply(`Setting up a task in ${repo}...`)
    .catch((error) => {
      console.error("Could not acknowledge task creation:", error);
      return undefined;
    });

  try {
    const { channel, provisioningError } = await createTaskChannelForRepo({
      guild,
      actorTag: message.author.tag,
      repo,
      prompt,
      context: taskContext,
    });
    const summary = provisioningError
      ? `Task channel created at ${channel}, but sandbox provisioning failed: ${provisioningError}`
      : `Task ready: ${channel}`;
    if (notice) {
      await notice.edit(summary);
    } else if ("send" in message.channel) {
      await message.channel.send(summary).catch(() => undefined);
    }

    if (!provisioningError) {
      await startTaskPrompt(channel, prompt, message.author.id).catch((error) => {
        console.error("Could not start the task session:", error);
        void channel
          .send(
            "I couldn't start your session. Mention me in the task channel to try again.",
          )
          .catch(() => undefined);
      });
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (notice) {
      await notice.edit(`Could not create the task: ${detail}`);
    }
  }
}

async function startTaskPrompt(
  channel: TextChannel,
  prompt: string,
  createdBy: string,
): Promise<void> {
  const thread = await channel.threads.create({
    name: createThreadName(prompt),
    type: ChannelType.PublicThread,
  });
  await createSession({
    threadId: thread.id,
    channelId: channel.id,
    openCodeSessionId: null,
    createdBy,
    createdAt: Date.now(),
  });
  const task = await getTask(channel.id);
  if (task) await updateStatusMessage(client, task);

  await runThreadPrompt({
    thread,
    channelId: channel.id,
    prompt,
    createdBy,
  });
}

async function classifyAction(
  message: Message,
  options: {
    surface: IntentSurface;
    taskActive: boolean;
    hasSession: boolean;
    botMentioned: boolean;
    recentTurns: ConversationTurn[];
  },
): Promise<IntentAction | undefined> {
  if (!message.content.trim()) {
    return options.botMentioned ? "chat" : undefined;
  }
  if (!intent) {
    return options.botMentioned ? "chat" : undefined;
  }

  const classification = await classifyMessage(
    {
      surface: options.surface,
      botMentioned: options.botMentioned,
      taskActive: options.taskActive,
      hasSession: options.hasSession,
      recentTurns: options.recentTurns,
      latest: latestTurn(message),
    },
    {
      apiKey: intent.apiKey,
      model: intent.model,
    },
  );
  const action = resolveIntentAction({
    classification,
    botMentioned: options.botMentioned,
    threshold: intent.confidenceThreshold,
  });
  console.log(
    `Intent for message ${message.id}: surface=${options.surface} mentioned=${options.botMentioned} turns=${options.recentTurns.length} directed=${classification?.directedAtBot.toFixed(2) ?? "n/a"} action=${classification?.action ?? "n/a"} confidence=${classification?.confidence.toFixed(2) ?? "n/a"} -> ${action ?? "silent"}`,
  );
  return action;
}

function latestTurn(message: Message): ConversationTurn {
  return {
    author: message.author.username,
    content: readableContent(message),
    isBot: false,
  };
}

function toTurn(message: Message): ConversationTurn {
  return {
    author: message.author.username,
    content: readableContent(message),
    isBot: message.author.bot,
  };
}

/** Drop the bot's own mention and render other user mentions as @username. */
function readableContent(message: Message): string {
  let content = stripBotMention(message.content, client.user?.id ?? "");
  for (const [id, user] of message.mentions.users) {
    content = content.replace(
      new RegExp(`<@!?${id}>`, "g"),
      `@${user.username}`,
    );
  }
  return content;
}

const RECENT_TURN_LIMIT = 10;

async function fetchRecentTurns(message: Message): Promise<ConversationTurn[]> {
  const channel = message.channel;
  if (!("messages" in channel)) return [];

  try {
    const fetched = await channel.messages.fetch({
      limit: RECENT_TURN_LIMIT,
      before: message.id,
    });
    const messages = [...fetched.values()].reverse();

    // A thread's history does not include the message it was started from, so
    // the request that opened the session would otherwise be missing.
    if (channel.isThread() && fetched.size < RECENT_TURN_LIMIT) {
      const starter = await channel.fetchStarterMessage().catch(() => null);
      if (starter && starter.id !== message.id) messages.unshift(starter);
    }

    return messages
      .map(toTurn)
      .filter((turn) => turn.content.trim().length > 0);
  } catch (error) {
    console.warn(
      "Could not fetch recent messages for intent context:",
      error instanceof Error ? error.message : String(error),
    );
    return [];
  }
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
      const task = await getTask(channelId);
      if (!task || task.status === "archived") {
        await statusMessage?.edit(
          "This channel is no longer an active task channel.",
        );
        return;
      }

      const { sandbox, rebuilt } = await getOrCreateSandbox({
        task,
        sandboxEnv,
        configHash,
        githubToken,
        tracing: phoenixTracing,
        guildName: thread.guild.name,
        networkIsolation,
        onRebuild: async () => {
          await clearSessionsForChannel(channelId);
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
          const rebuiltTask = await getTask(channelId);
          if (rebuiltTask) {
            await updateStatusMessage(client, rebuiltTask);
          }
        },
      });

      if (
        sandbox.id !== task.sandboxId ||
        task.configHash !== configHash
      ) {
        const readyTask = await updateTask(channelId, {
          sandboxId: sandbox.id,
          configHash,
          status: "ready",
        });
        if (readyTask) await updateStatusMessage(client, readyTask);
      }

      let session = await getSession(thread.id);
      if (rebuilt || !session) {
        await createSession({
          threadId: thread.id,
          channelId,
          openCodeSessionId: null,
          createdBy,
          createdAt: Date.now(),
        });
        session = await getSession(thread.id);
        const taskWithSession = await getTask(channelId);
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
        await updateSessionOpenCodeId(thread.id, response.sessionId ?? null);
      }
      await sendDiscordChunks(thread, statusMessage, response.text);
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

async function sendDiscordChunks(
  thread: AnyThreadChannel,
  statusMessage: Message | undefined,
  text: string,
): Promise<void> {
  const [first, ...rest] = splitForDiscord(text);
  if (statusMessage) {
    await statusMessage.edit(first || "OpenCode finished with no output.");
  } else if (first) {
    await thread.send(first);
  }

  for (const chunk of rest) {
    await thread.send(chunk).catch((error) => {
      console.error("Could not send Discord message continuation:", error);
    });
  }
}