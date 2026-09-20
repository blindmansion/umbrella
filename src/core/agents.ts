import type { SandboxHandle } from "./ports";

/**
 * OpenCode reads global rules from `~/.config/opencode/AGENTS.md`. The sandbox
 * runs as root, so this is the path that makes the instructions visible no
 * matter which worktree a thread runs in.
 */
export const SANDBOX_AGENTS_PATH = "/root/.config/opencode/AGENTS.md";

/**
 * Instructions installed into every sandbox so the worker knows a task is
 * expected to end in a committed branch with an open pull request.
 */
export const SANDBOX_AGENTS_MD = `# Sandbox agent instructions

You are an agent running inside an ephemeral sandbox with a Git repository
cloned into it. A user collaborates with you on a task in a thread, and the
task should result in code changes published as a pull request.

When the task involves code changes:

- Commit your work on the current branch and push it to the remote.
- Open a pull request against the base branch the user asked for, defaulting to
  \`main\` when none is specified.
- If the base branch has moved on, rebase your branch onto it and resolve any
  merge conflicts before opening or updating the pull request.

Do not stop to ask whether the work should be committed or turned into a pull
request. Opening the pull request is the expected outcome once the task is
done, not a question for the user to answer.
`;

export async function installSandboxAgentInstructions(
  sandbox: SandboxHandle,
): Promise<void> {
  await sandbox.mkdir("/root/.config/opencode");
  await sandbox.writeFile(SANDBOX_AGENTS_PATH, SANDBOX_AGENTS_MD);
}
