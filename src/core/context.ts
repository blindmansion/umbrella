import type {
  GitHubMetadata,
  GitHubReference,
  TaskKind,
} from "./ports";
import type { SessionWorkspace } from "./worktrees";

const MAX_CONTEXT_LENGTH = 4_000;

export function buildReferenceContext(options: {
  kind: TaskKind;
  repo: string;
  refNumber: number;
  branch: string;
  reference: GitHubReference;
  metadata: GitHubMetadata;
}): string {
  const { kind, repo, refNumber, branch, reference, metadata } = options;
  const isPull = reference.urlKind === "pull";
  const label = isPull ? "Pull request" : "Issue";
  const url = `https://github.com/${repo}/${isPull ? "pull" : "issues"}/${refNumber}`;
  const lines = [
    "Task context (provided automatically; you do not need to ask for it):",
    `- ${label}: ${repo}#${refNumber}${metadata.title ? ` — ${metadata.title}` : ""}`,
    `- URL: ${url}`,
    `- Kind: ${kind}`,
    `- Branch: ${branch}`,
  ];

  const body = metadata.body?.trim();
  if (body) {
    lines.push("", `${label} description:`, truncate(body, MAX_CONTEXT_LENGTH));
  }
  return lines.join("\n");
}

export function buildRepoContext(options: {
  kind: TaskKind;
  repo: string;
  branch: string;
  request?: string;
}): string {
  const { kind, repo, branch, request } = options;
  const lines = [
    "Task context (provided automatically; you do not need to ask for it):",
    `- Repository: ${repo}`,
    `- Kind: ${kind}`,
    `- Branch: ${branch}`,
  ];

  const trimmed = request?.trim();
  if (trimmed) {
    lines.push("", "Original request:", truncate(trimmed, MAX_CONTEXT_LENGTH));
  }
  return lines.join("\n");
}

export function buildWorkspaceContext(workspace: SessionWorkspace): string {
  return [
    "Session workspace (created automatically for this thread):",
    `- Directory: ${workspace.path}`,
    `- Branch: ${workspace.branch}`,
    "- Do your work here; other threads use separate worktrees of the same repository.",
  ].join("\n");
}

export function buildFirstPrompt(
  context: string | null | undefined,
  prompt: string,
  workspace?: SessionWorkspace,
): string {
  const sections = [
    context?.trim(),
    workspace ? buildWorkspaceContext(workspace) : undefined,
    prompt.trim(),
  ].filter((section): section is string => Boolean(section));
  if (sections.length === 0) return prompt;
  return sections.join("\n\n---\n\n");
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n… (truncated)`;
}
