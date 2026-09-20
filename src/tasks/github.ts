import type { TaskKind } from "../store";

export type GitHubReference = {
  owner: string;
  name: string;
  number: number;
  urlKind: "issue" | "pull";
};

export type RepoReference = {
  owner: string;
  name: string;
};

export type GitHubMetadata = {
  title?: string;
  body?: string;
  headRef?: string;
  defaultBranch?: string;
};

export type GitHubIssue = {
  number: number;
  title: string;
  url: string;
};

export function parseRepoFullName(value: string): RepoReference | undefined {
  const match = value.trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) return undefined;
  return { owner: match[1]!, name: match[2]! };
}

function githubHeaders(githubToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "railway-opencode-discord-bot",
  };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
  return headers;
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

export async function fetchGitHubMetadata(
  reference: GitHubReference,
  githubToken?: string,
): Promise<GitHubMetadata> {
  const headers = githubHeaders(githubToken);

  const base = `https://api.github.com/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.name)}`;
  const metadata: GitHubMetadata = {};
  const detailPath =
    reference.urlKind === "pull"
      ? `pulls/${reference.number}`
      : `issues/${reference.number}`;

  const [detailResult, repoResult] = await Promise.allSettled([
    fetch(`${base}/${detailPath}`, { headers }),
    fetch(base, { headers }),
  ]);

  if (detailResult.status === "fulfilled" && detailResult.value.ok) {
    try {
      const detail = (await detailResult.value.json()) as {
        title?: unknown;
        body?: unknown;
        head?: { ref?: unknown };
      };
      if (typeof detail.title === "string") metadata.title = detail.title;
      if (typeof detail.body === "string") metadata.body = detail.body;
      if (typeof detail.head?.ref === "string") metadata.headRef = detail.head.ref;
    } catch {
      // Fall back to URL-derived metadata.
    }
  }
  if (repoResult.status === "fulfilled" && repoResult.value.ok) {
    try {
      const repo = (await repoResult.value.json()) as {
        default_branch?: unknown;
      };
      if (typeof repo.default_branch === "string") {
        metadata.defaultBranch = repo.default_branch;
      }
    } catch {
      // Fall back to "main".
    }
  }

  return metadata;
}

export async function fetchRepoDefaultBranch(
  repo: RepoReference,
  githubToken?: string,
): Promise<string | undefined> {
  const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  try {
    const response = await fetch(url, { headers: githubHeaders(githubToken) });
    if (!response.ok) return undefined;
    const data = (await response.json()) as { default_branch?: unknown };
    return typeof data.default_branch === "string"
      ? data.default_branch
      : undefined;
  } catch {
    return undefined;
  }
}

export function buildIssueUrl(repo: RepoReference, number: number): string {
  return `https://github.com/${repo.owner}/${repo.name}/issues/${number}`;
}

export async function fetchOpenIssues(
  repo: RepoReference,
  githubToken?: string,
): Promise<GitHubIssue[]> {
  const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/issues?state=open&sort=updated&direction=desc&per_page=100`;
  try {
    const response = await fetch(url, { headers: githubHeaders(githubToken) });
    if (!response.ok) return [];
    const data = (await response.json()) as unknown;
    if (!Array.isArray(data)) return [];
    return data.flatMap((item): GitHubIssue[] => {
      if (
        !item ||
        typeof item.number !== "number" ||
        typeof item.title !== "string" ||
        item.pull_request
      ) {
        return [];
      }
      const url =
        typeof item.html_url === "string"
          ? item.html_url
          : buildIssueUrl(repo, item.number);
      return [{ number: item.number, title: item.title, url }];
    });
  } catch {
    return [];
  }
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
