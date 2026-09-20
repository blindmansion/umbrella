import { runOpenCode } from "./opencode";
import { splitOutput } from "./output";
import type { Deps, SandboxHandle, TaskRecord } from "./ports";
import { buildFirstPrompt } from "./context";
import { updateStatusMessage } from "./provision";
import { ChannelQueue } from "./queue";
import { buildRehydrationPrompt } from "./routing";
import { SandboxManager } from "./sandboxes";
import type { SessionWorkspace } from "./worktrees";

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
  triggerMessageId?: string;
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
    triggerMessageId,
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
    const waitingForSandbox = queue.depth(channelId) > 0;
    status = await deps.chat.send(
      threadId,
      waitingForSandbox
        ? "Waiting to prepare the shared sandbox..."
        : "Working in OpenCode...",
    );
    const prepared = await queue.runExclusive(channelId, () =>
      prepareThreadWorkspace({
        deps,
        manager,
        threadId,
        channelId,
        guildName,
        prompt,
        createdBy,
        includeContext,
      }),
    );
    if (!prepared) {
      await deps.chat.edit(
        status,
        "This channel is no longer an active task channel.",
      );
      return;
    }
    if (waitingForSandbox) {
      await deps.chat.edit(status, "Working in OpenCode...");
    }

    const contextPrompt = prepared.sessionPrompt;
    let storedSessionId = prepared.storedSessionId;
    let promptToRun = contextPrompt;
    let step = 0;

    const runPrompt = (
      sessionId: string | undefined,
      activePrompt: string,
    ) =>
      runOpenCode({
        sandbox: prepared.sandbox,
        model: prepared.model,
        prompt: activePrompt,
        sessionId,
        cwd: prepared.workspace.path,
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

    // A rebuilt sandbox invalidated every stored session. Seed a fresh one
    // with the thread's history so the conversation can continue.
    if (prepared.rebuilt) {
      const transcript = await deps.chat.transcript(threadId, {
        excludeId: triggerMessageId,
      });
      if (transcript.length > 0) {
        promptToRun = buildRehydrationPrompt({
          task: prepared.task,
          transcript,
          prompt: contextPrompt,
        });
        await deps.chat.send(
          threadId,
          "The sandbox was rebuilt, so I'm continuing in a new session seeded with this thread's history.",
        );
      }
    }

    let response: Awaited<ReturnType<typeof runOpenCode>>;
    try {
      response = await runPrompt(storedSessionId, promptToRun);
    } catch (error) {
      // A restored checkpoint can predate the session, or the resume can
      // otherwise fail. Fall back to a fresh session hydrated from history.
      if (!storedSessionId) throw error;
      console.warn(
        "Could not resume OpenCode session; starting a new one from thread history:",
        error instanceof Error ? error.message : String(error),
      );
      const transcript = await deps.chat.transcript(threadId, {
        excludeId: triggerMessageId,
      });
      const retryPrompt =
        transcript.length > 0
          ? buildRehydrationPrompt({
              task: prepared.task,
              transcript,
              prompt: contextPrompt,
            })
          : contextPrompt;
      storedSessionId = undefined;
      response = await runPrompt(undefined, retryPrompt);
    }

    if (response.sessionId !== storedSessionId) {
      await deps.store.updateSessionOpenCodeId(
        threadId,
        response.sessionId ?? null,
      );
    }
    await sendChunks(deps, threadId, status, response.text);
    await manager.captureCheckpoint(prepared.sandbox, channelId);
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

async function prepareThreadWorkspace(options: {
  deps: Deps;
  manager: SandboxManager;
  threadId: string;
  channelId: string;
  guildName: string;
  prompt: string;
  createdBy: string;
  includeContext: boolean;
}): Promise<
  | {
       sandbox: SandboxHandle;
       workspace: SessionWorkspace;
       storedSessionId: string | undefined;
       model: string;
       sessionPrompt: string;
       rebuilt: boolean;
       task: TaskRecord;
     }
  | undefined
> {
  const {
    deps,
    manager,
    threadId,
    channelId,
    guildName,
    prompt,
    createdBy,
    includeContext,
  } = options;
  const task = await deps.store.getTask(channelId);
  if (!task || task.status === "archived") return undefined;

  const { sandbox, rebuilt, configHash } = await manager.getOrCreate({
    task,
    guildName,
    onRebuild: async () => {
      await deps.store.clearSessionOpenCodeIdsForChannel(channelId);
      await deps.chat.send(
        channelId,
        "The task sandbox was rebuilt. Each thread will continue from its Discord history.",
      );
      const rebuiltTask = await deps.store.getTask(channelId);
      if (rebuiltTask) await updateStatusMessage(deps, rebuiltTask);
    },
  });
  if (sandbox.id !== task.sandboxId || task.configHash !== configHash) {
    const ready = await deps.store.updateTask(channelId, {
      sandboxId: sandbox.id,
      configHash,
      status: "ready",
    });
    if (ready) await updateStatusMessage(deps, ready);
  }

  let session = await deps.store.getSession(threadId);
  if (!session) {
    await deps.store.createSession({
      threadId,
      channelId,
      openCodeSessionId: null,
      model: null,
      worktreePath: null,
      branch: null,
      createdBy,
      createdAt: (deps.clock ?? Date.now)(),
    });
    session = await deps.store.getSession(threadId);
    const withSession = await deps.store.getTask(channelId);
    if (withSession) await updateStatusMessage(deps, withSession);
  }
  const workspace = await manager.ensureWorktree({
    sandbox,
    task,
    threadId,
    session,
  });
  if (
    session?.worktreePath !== workspace.path ||
    session?.branch !== workspace.branch
  ) {
    await deps.store.updateSessionWorktree(threadId, workspace);
  }
  const storedSessionId = session?.openCodeSessionId ?? undefined;
  return {
    sandbox,
    workspace,
    storedSessionId,
    model: session?.model ?? task.model ?? deps.config.model,
    sessionPrompt:
      storedSessionId === undefined
        ? buildFirstPrompt(
            includeContext ? task.context : null,
            prompt,
            workspace,
          )
        : prompt,
    rebuilt,
    task,
  };
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
