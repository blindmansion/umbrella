import { runOpenCode } from "./opencode";
import { splitOutput } from "./output";
import type { Deps } from "./ports";
import { buildFirstPrompt } from "./context";
import { updateStatusMessage } from "./provision";
import { ChannelQueue } from "./queue";
import { SandboxManager } from "./sandboxes";

export async function runThreadPrompt(options: {
  deps: Deps;
  manager: SandboxManager;
  queue: ChannelQueue;
  inFlight: Set<string>;
  threadId: string;
  channelId: string;
  guildName: string;
  prompt: string;
  createdBy: string;
  includeContext?: boolean;
}): Promise<void> {
  const {
    deps,
    manager,
    queue,
    inFlight,
    threadId,
    channelId,
    guildName,
    prompt,
    createdBy,
    includeContext = true,
  } = options;
  if (inFlight.has(threadId)) {
    await deps.chat.send(
      threadId,
      "I'm still working on the previous prompt in this thread.",
    );
    return;
  }

  inFlight.add(threadId);
  let status = undefined;
  try {
    const depth = queue.depth(channelId);
    status = await deps.chat.send(
      threadId,
      depth > 0
        ? `Queued behind ${depth} running session${depth === 1 ? "" : "s"}...`
        : "Working in OpenCode...",
    );
    await queue.runExclusive(channelId, async () => {
      const task = await deps.store.getTask(channelId);
      if (!task || task.status === "archived") {
        await deps.chat.edit(
          status!,
          "This channel is no longer an active task channel.",
        );
        return;
      }
      const { sandbox, rebuilt } = await manager.getOrCreate({
        task,
        guildName,
        onRebuild: async () => {
          await deps.store.clearSessionsForChannel(channelId);
          await deps.chat.send(
            channelId,
            "The task sandbox was rebuilt. Previous thread sessions can't be resumed.",
          );
          const rebuiltTask = await deps.store.getTask(channelId);
          if (rebuiltTask) await updateStatusMessage(deps, rebuiltTask);
        },
      });
      if (
        sandbox.id !== task.sandboxId ||
        task.configHash !== deps.config.configHash
      ) {
        const ready = await deps.store.updateTask(channelId, {
          sandboxId: sandbox.id,
          configHash: deps.config.configHash,
          status: "ready",
        });
        if (ready) await updateStatusMessage(deps, ready);
      }

      let session = await deps.store.getSession(threadId);
      if (rebuilt || !session) {
        await deps.store.createSession({
          threadId,
          channelId,
          openCodeSessionId: null,
          model: null,
          createdBy,
          createdAt: (deps.clock ?? Date.now)(),
        });
        session = await deps.store.getSession(threadId);
        const withSession = await deps.store.getTask(channelId);
        if (withSession) await updateStatusMessage(deps, withSession);
      }
      const storedSessionId = session?.openCodeSessionId ?? undefined;
      const model = session?.model ?? task.model ?? deps.config.model;
      const sessionPrompt =
        storedSessionId === undefined && includeContext
          ? buildFirstPrompt(task.context, prompt)
          : prompt;
      let step = 0;
      const response = await runOpenCode({
        sandbox,
        model,
        prompt: sessionPrompt,
        sessionId: storedSessionId,
        onProgress: async (event) => {
          if (event.type === "step_start") {
            step += 1;
            await deps.chat.edit(
              status!,
              step === 1
                ? "OpenCode is thinking..."
                : `OpenCode is continuing (step ${step})...`,
            );
          } else if (event.type === "error") {
            await deps.chat.send(threadId, "✗ OpenCode reported an error.");
          }
        },
      });
      if (response.sessionId !== storedSessionId) {
        await deps.store.updateSessionOpenCodeId(
          threadId,
          response.sessionId ?? null,
        );
      }
      await sendChunks(deps, threadId, status!, response.text);
    });
  } catch (error) {
    console.error("OpenCode run failed:", error);
    if (status) {
      await deps.chat
        .edit(status, "OpenCode failed to finish. Check the bot logs for details.")
        .catch(() => undefined);
    }
  } finally {
    inFlight.delete(threadId);
  }
}

async function sendChunks(
  deps: Pick<Deps, "chat">,
  threadId: string,
  status: { id: string; channelId: string },
  text: string,
): Promise<void> {
  const chunks = splitOutput(text);
  await deps.chat.edit(
    status,
    chunks.shift() || "OpenCode finished with no output.",
  );
  for (const chunk of chunks) await deps.chat.send(threadId, chunk);
}
