import type {
  GitHubMetadata,
  GitHubReference,
  TaskKind,
} from "./ports";

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

export function buildFirstPrompt(
  context: string | null | undefined,
  prompt: string,
): string {
  const prefix = context?.trim();
  const body = prompt.trim();
  if (!prefix) return prompt;
  if (!body) return prefix;
  return `${prefix}\n\n---\n\n${body}`;
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n… (truncated)`;
}
