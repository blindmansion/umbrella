import { shellQuote } from "./utils";

export const WORKTREES_ROOT = "/root/worktrees";

export type SessionWorkspace = {
  path: string;
  branch: string;
};

export function sanitizeWorktreeId(threadId: string): string {
  const cleaned = threadId
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 64) || "session";
}

export function worktreePathFor(threadId: string): string {
  return `${WORKTREES_ROOT}/${sanitizeWorktreeId(threadId)}`;
}

export function worktreeBranchFor(
  taskBranch: string,
  threadId: string,
): string {
  const suffix = sanitizeWorktreeId(threadId);
  const branch = `${taskBranch}-${suffix}`;
  return branch.slice(0, 200);
}

export function buildWorktreeCommand(options: {
  path: string;
  branch: string;
  startPoint: string;
}): string {
  const { path, branch, startPoint } = options;
  const ref = `refs/heads/${branch}`;
  return [
    "set -e",
    `if [ -d ${shellQuote(path)} ]; then exit 0; fi`,
    "git worktree prune",
    `mkdir -p "$(dirname ${shellQuote(path)})"`,
    `if git show-ref --verify --quiet ${shellQuote(ref)}; then`,
    `  git worktree add ${shellQuote(path)} ${shellQuote(branch)}`,
    "else",
    `  git worktree add -b ${shellQuote(branch)} ${shellQuote(path)} ${shellQuote(startPoint)}`,
    "fi",
  ].join("\n");
}
