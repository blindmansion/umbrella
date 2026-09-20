import type {
  GitHubIssue,
  GitHubMetadata,
  GitHubReference,
  RepoReference,
  TaskKind,
} from "./ports";

export function parseRepoFullName(value: string): RepoReference | undefined {
  const match = value.trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  return match ? { owner: match[1]!, name: match[2]! } : undefined;
}

export function parseGitHubUrl(value: string): GitHubReference | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    return undefined;
  }
  const match = url.pathname.match(
    /^\/([^/]+)\/([^/]+)\/(issues|pull)\/([1-9]\d*)\/?$/,
  );
  if (!match) return undefined;
  return {
    owner: match[1]!,
    name: match[2]!,
    urlKind: match[3] === "pull" ? "pull" : "issue",
    number: Number(match[4]),
  };
}

export function findGitHubReference(
  content: string,
): GitHubReference | undefined {
  const matches = content.match(
    /https:\/\/github\.com\/[^\s<>()]+?\/(?:issues|pull)\/[1-9]\d*/gi,
  );
  if (!matches) return undefined;
  for (const match of matches) {
    const reference = parseGitHubUrl(match);
    if (reference) return reference;
  }
  return undefined;
}

export function buildIssueUrl(repo: RepoReference, number: number): string {
  return `https://github.com/${repo.owner}/${repo.name}/issues/${number}`;
}

function scoreToken(text: string, token: string): number | undefined {
  const index = text.indexOf(token);
  if (index !== -1) return 100 - Math.min(index, 80);
  let matched = 0;
  let gaps = 0;
  let previous = -1;
  for (let i = 0; i < text.length && matched < token.length; i++) {
    if (text[i] === token[matched]) {
      if (previous !== -1) gaps += i - previous - 1;
      previous = i;
      matched++;
    }
  }
  if (matched < token.length) return undefined;
  return Math.max(1, 40 - Math.min(gaps, 39));
}

export function rankIssues(
  issues: GitHubIssue[],
  query: string,
): GitHubIssue[] {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/^#+/, ""))
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return issues;

  const scored: { issue: GitHubIssue; score: number }[] = [];
  for (const issue of issues) {
    const haystack = `${issue.number} ${issue.title}`.toLowerCase();
    let total = 0;
    let matched = true;
    for (const token of tokens) {
      const score = scoreToken(haystack, token);
      if (score === undefined) {
        matched = false;
        break;
      }
      total += score;
    }
    if (matched) scored.push({ issue, score: total });
  }
  scored.sort((a, b) => b.score - a.score || a.issue.number - b.issue.number);
  return scored.map((entry) => entry.issue);
}

export function inferBranch(options: {
  kind: TaskKind;
  number: number;
  slug: string;
  explicitBranch?: string;
  metadata: GitHubMetadata;
}): string {
  if (options.explicitBranch) return options.explicitBranch;
  if (options.kind === "feature") {
    return `feat/${options.number}-${options.slug}`;
  }
  if (options.kind === "review" && options.metadata.headRef) {
    return options.metadata.headRef;
  }
  return options.metadata.defaultBranch ?? "main";
}
