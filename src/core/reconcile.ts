import { parseRepoFullName } from "./github";
import type { Deps, GitHubReference, TaskRecord } from "./ports";
import { completeTask } from "./provision";
import { SandboxManager } from "./sandboxes";
import { sanitizeError } from "./utils";

export type ReconcileResult = {
  /** Tasks with a linked GitHub reference whose state was checked. */
  checked: number;
  /** Task channel IDs completed because their reference closed. */
  completed: string[];
  /** Task channel IDs whose check or cleanup failed and should be retried. */
  failed: string[];
};

const RECONCILE_CONCURRENCY = 4;

/**
 * Complete tasks whose linked GitHub issue or pull request has closed since the
 * task was created. Repository tasks (no reference) are left alone. This is
 * best-effort: a failed lookup leaves the task for the next pass.
 */
export async function reconcileClosedReferences(
  deps: Deps,
  manager: SandboxManager,
  options: { logger?: (message: string) => void } = {},
): Promise<ReconcileResult> {
  const log = options.logger ?? console.log;
  const tasks = await deps.store.listActiveTasks();
  const candidates = tasks.filter((task) => task.refNumber !== null);
  const result: ReconcileResult = { checked: 0, completed: [], failed: [] };

  await forEachWithConcurrency(candidates, RECONCILE_CONCURRENCY, async (task) => {
    const reference = referenceForTask(task);
    if (!reference) return;
    result.checked += 1;
    try {
      const state = await deps.github.fetchReferenceState(reference);
      if (!state || (state.state === "open" && !state.merged)) return;
      await completeTask(deps, manager, task.channelId);
      result.completed.push(task.channelId);
      log(
        `Auto-completed task ${task.channelId} (${task.repo}#${task.refNumber}): linked reference is closed.`,
      );
    } catch (error) {
      result.failed.push(task.channelId);
      log(
        `Could not auto-close task ${task.channelId} (${task.repo}#${task.refNumber}): ${sanitizeError(error)}`,
      );
    }
  });

  return result;
}

function referenceForTask(task: TaskRecord): GitHubReference | undefined {
  if (task.refNumber === null) return undefined;
  const repo = parseRepoFullName(task.repo);
  if (!repo) return undefined;
  return {
    owner: repo.owner,
    name: repo.name,
    number: task.refNumber,
    urlKind: task.kind === "review" ? "pull" : "issue",
  };
}

async function forEachWithConcurrency<T>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const current = index;
        index += 1;
        if (current >= items.length) return;
        await run(items[current]!);
      }
    },
  );
  await Promise.all(workers);
}
