import type {
  Command,
  CommandResult,
  Deps,
  IncomingMessage,
} from "./ports";
import { findGitHubReference, parseRepoFullName } from "./github";
import { runThreadPrompt } from "./prompts";
import {
  closeTask,
  provisionFromCommand,
  updateStatusMessage,
} from "./provision";
import { ChannelQueue } from "./queue";
import {
  buildPendingPrompt,
  classifyAction,
  createThreadName,
  latestTurn,
} from "./routing";
import { SandboxManager } from "./sandboxes";
import { sanitizeError } from "./utils";

export function createUmbrella(deps: Deps) {
  const manager = new SandboxManager(deps.sandboxes, deps.config);
  const queue = new ChannelQueue();
  const inFlight = new Set<string>();

  const runPrompt = (options: {
    msg: IncomingMessage;
    threadId: string;
    channelId: string;
    prompt: string;
    createdBy: string;
    includeContext?: boolean;
  }) =>
    runThreadPrompt({
      deps,
      manager,
      queue,
      inFlight,
      threadId: options.threadId,
      channelId: options.channelId,
      guildName: options.msg.guildName,
      prompt: options.prompt,
      createdBy: options.createdBy,
      includeContext: options.includeContext,
    });

  async function onMessage(msg: IncomingMessage): Promise<void> {
    if (msg.threadId) {
      const session = await deps.store.getSession(msg.threadId);
      if (!session) {
        if (msg.botMentioned) {
          await deps.chat.reply(
            msg,
            "This thread isn't a bot session. Mention me in the parent channel to start one.",
          );
        }
        return;
      }
      const recentTurns = await deps.chat.recentTurns(msg);
      const action = await classifyAction(deps, msg, {
        surface: "thread",
        taskActive: true,
        hasSession: true,
        botMentioned: msg.botMentioned,
        recentTurns,
      });
      if (!action) return;
      if (action === "reset") {
        await deps.store.updateSessionOpenCodeId(msg.threadId, null);
        await deps.chat.reply(
          msg,
          "Session reset. Your next prompt will start a fresh OpenCode session in the same sandbox.",
        );
        return;
      }
      if (action !== "chat" && action !== "create_task") return;
      const prompt = buildPendingPrompt(recentTurns, latestTurn(msg));
      if (!prompt) {
        if (msg.botMentioned) {
          await deps.chat.reply(
            msg,
            "Mention me with a prompt, for example: `@umbrella investigate the failing test`.",
          );
        }
        return;
      }
      await runPrompt({
        msg,
        threadId: msg.threadId,
        channelId: session.channelId,
        prompt,
        createdBy: session.createdBy ?? msg.authorId,
      });
      return;
    }

    const task = await deps.store.getTask(msg.channelId);
    const taskActive = Boolean(task && task.status !== "archived");
    const reference = findGitHubReference(msg.text);
    const recentTurns =
      deps.classifier || taskActive ? await deps.chat.recentTurns(msg) : [];
    const action = await classifyAction(deps, msg, {
      surface: taskActive ? "task_channel" : "other",
      taskActive,
      hasSession: false,
      botMentioned: msg.botMentioned,
      recentTurns,
    });

    if (!taskActive || !task) {
      if (reference && (action === "create_task" || msg.botMentioned)) {
        const notice = await deps.chat.reply(
          msg,
          `Setting up a task for ${reference.owner}/${reference.name}#${reference.number}...`,
        );
        const result = await onCommand({
          type: "task",
          guildId: msg.guildId,
          guildName: msg.guildName,
          actorId: msg.authorId,
          actorName: msg.authorName,
          reference,
        });
        await deps.chat.edit(notice, result.message);
        return;
      }
      const wantsRepoTask =
        !reference &&
        msg.text.trim().length > 0 &&
        (action === "create_task" || action === "chat");
      if (wantsRepoTask) {
        const configured = await deps.store.getGuildRepo(msg.guildId);
        if (configured) {
          const notice = await deps.chat.reply(
            msg,
            `Setting up a task in ${configured.repo}...`,
          );
          const result = await provisionFromCommand(deps, manager, queue, {
            type: "task",
            guildId: msg.guildId,
            guildName: msg.guildName,
            actorId: msg.authorId,
            actorName: msg.authorName,
            repo: configured.repo,
            prompt: msg.text,
          });
          await deps.chat.edit(
            notice,
            result.provisioningError
              ? `Task channel created at <#${result.channelId}>, but sandbox provisioning failed: ${result.provisioningError}`
              : `Task ready: <#${result.channelId}>`,
          );
          if (!result.provisioningError) {
            try {
              const synthetic = { ...msg, channelId: result.channelId };
              const threadId = await deps.chat.startThread(
                synthetic,
                createThreadName(msg.text),
              );
              await deps.store.createSession({
                threadId,
                channelId: result.channelId,
                openCodeSessionId: null,
                model: null,
                worktreePath: null,
                branch: null,
                createdBy: msg.authorId,
                createdAt: (deps.clock ?? Date.now)(),
              });
              const withSession = await deps.store.getTask(result.channelId);
              if (withSession) await updateStatusMessage(deps, withSession);
              await runPrompt({
                msg: synthetic,
                threadId,
                channelId: result.channelId,
                prompt: msg.text,
                createdBy: msg.authorId,
                includeContext: false,
              });
            } catch (error) {
              console.error("Could not start task session:", error);
              await deps.chat.send(
                result.channelId,
                "I couldn't start your session. Mention me in the task channel to try again.",
              );
            }
          }
          return;
        }
        if (msg.botMentioned || action === "create_task") {
          await deps.chat.reply(
            msg,
            "This server doesn't have a task repository yet. An admin can set one with `/repo set owner/name`, or share a GitHub issue or pull request URL.",
          );
          return;
        }
      }
      if (msg.botMentioned) {
        await deps.chat.reply(
          msg,
          "This channel isn't an active task channel. Share a GitHub issue or pull request URL and I'll set one up, or ask an admin to set a default repository with `/repo set owner/name`.",
        );
      }
      return;
    }

    if (action === "close") {
      await deps.chat.reply(msg, "Closing this task and destroying its sandbox...");
      await closeTask(deps, manager, msg.channelId);
      return;
    }
    if (action === "create_task" && reference) {
      const notice = await deps.chat.reply(
        msg,
        `Setting up a task for ${reference.owner}/${reference.name}#${reference.number}...`,
      );
      const result = await onCommand({
        type: "task",
        guildId: msg.guildId,
        guildName: msg.guildName,
        actorId: msg.authorId,
        actorName: msg.authorName,
        reference,
      });
      await deps.chat.edit(notice, result.message);
      return;
    }
    if (action === "reset") {
      await manager.destroy(msg.channelId, task.sandboxId);
      await deps.store.clearSessionsForChannel(msg.channelId);
      const reset = await deps.store.updateTask(msg.channelId, {
        sandboxId: null,
        status: "provisioning",
      });
      if (reset) await updateStatusMessage(deps, reset);
      await deps.chat.reply(
        msg,
        "The sandbox was destroyed and all thread sessions were invalidated. A fresh sandbox will be built on the next prompt.",
      );
      return;
    }
    if (action !== "chat" && action !== "create_task") return;
    const prompt =
      msg.text.trim() || buildPendingPrompt(recentTurns, latestTurn(msg));
    if (!prompt) {
      await deps.chat.reply(
        msg,
        "Mention me with a prompt, for example: `@umbrella investigate the failing test`.",
      );
      return;
    }
    const threadId = await deps.chat.startThread(msg, createThreadName(prompt));
    await deps.store.createSession({
      threadId,
      channelId: msg.channelId,
      openCodeSessionId: null,
      model: null,
      worktreePath: null,
      branch: null,
      createdBy: msg.authorId,
      createdAt: (deps.clock ?? Date.now)(),
    });
    const withSession = await deps.store.getTask(msg.channelId);
    if (withSession) await updateStatusMessage(deps, withSession);
    await runPrompt({
      msg,
      threadId,
      channelId: msg.channelId,
      prompt,
      createdBy: msg.authorId,
    });
  }

  async function onCommand(command: Command): Promise<CommandResult> {
    try {
      if (command.type === "task") {
        const result = await provisionFromCommand(
          deps,
          manager,
          queue,
          command,
        );
        return {
          ok: !result.provisioningError,
          channelId: result.channelId,
          message: result.provisioningError
            ? `Task channel created at <#${result.channelId}>, but sandbox provisioning failed: ${result.provisioningError}`
            : `Task ready: <#${result.channelId}>`,
        };
      }
      if (command.type === "close") {
        await closeTask(deps, manager, command.channelId);
        return {
          ok: true,
          message:
            "Task archived and its sandbox destroyed. Channel history has been preserved.",
        };
      }
      if (command.type === "repo") {
        if (command.action === "clear") {
          await deps.store.clearGuildRepo(command.guildId);
          return { ok: true, message: "This server's task repository has been cleared." };
        }
        if (command.action === "set") {
          const parsed = command.repo && parseRepoFullName(command.repo);
          if (!parsed) {
            return { ok: false, message: "Use a repository in `owner/name` form." };
          }
          const repo = `${parsed.owner}/${parsed.name}`;
          await deps.store.setGuildRepo(command.guildId, repo);
          return {
            ok: true,
            message: `This server's task repository is now \`${repo}\`.`,
          };
        }
        const current = await deps.store.getGuildRepo(command.guildId);
        return {
          ok: true,
          message: current
            ? `This server's task repository is \`${current.repo}\`.`
            : "No task repository is set. An admin can set one with `/repo set owner/name`.",
        };
      }

      const model = command.model?.replace(/[\u0000-\u001f\u007f]/g, "").trim();
      if (model && (/\s/.test(model) || model.length > 200)) {
        return { ok: false, message: "That model name isn't valid." };
      }
      if (command.threadId) {
        const session = await deps.store.getSession(command.threadId);
        if (!session) {
          return { ok: false, message: "This thread isn't a bot session." };
        }
        if (!model) {
          return {
            ok: true,
            message: session.model
              ? `This session uses \`${session.model}\`. Pass a \`model\` option to choose one.`
              : "This session uses the server default. Pass a `model` option to choose one.",
          };
        }
        await deps.store.updateSessionModel(command.threadId, model);
        manager.clearModelCache(session.channelId);
        return {
          ok: true,
          message: `This session will use \`${model}\` for subsequent prompts.`,
        };
      }
      const task = await deps.store.getTask(command.channelId);
      if (!task || task.status === "archived") {
        return { ok: false, message: "`/model` must be used inside an active task." };
      }
      if (!model) {
        return {
          ok: true,
          message: task.model
            ? `This task uses \`${task.model}\`. New threads inherit it. Pass a \`model\` option to choose one for new threads.`
            : "This task uses the server default. Pass a `model` option to choose one for new threads.",
        };
      }
      const updated = await deps.store.updateTask(task.channelId, { model });
      if (updated) await updateStatusMessage(deps, updated);
      manager.clearModelCache(task.channelId);
      return {
        ok: true,
        message: `New sessions in this task will use \`${model}\`.`,
      };
    } catch (error) {
      const message = sanitizeError(error, [
        deps.config.githubToken ?? "",
        ...Object.values(deps.config.sandboxEnv),
      ]);
      return {
        ok: false,
        message:
          command.type === "task"
            ? `Could not create the task: ${message}`
            : message,
      };
    }
  }

  return {
    onMessage,
    onCommand,
    getAvailableModels: async (channelId: string) => {
      const task = await deps.store.getTask(channelId);
      if (!task?.sandboxId) return [];
      const sandbox = await manager.getExisting(channelId, task.sandboxId);
      return sandbox ? manager.availableModels(channelId, sandbox) : [];
    },
  };
}
