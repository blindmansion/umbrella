import { buildIssueUrl } from "../../core/github";
import type {
  GitHubClient,
  GitHubIssue,
  GitHubMetadata,
  GitHubReference,
  GitHubReferenceState,
  RepoReference,
} from "../../core/ports";

export function createGitHubClient(token?: string): GitHubClient {
  return {
    fetchMetadata: (reference) => fetchGitHubMetadata(reference, token),
    fetchDefaultBranch: (repo) => fetchRepoDefaultBranch(repo, token),
    fetchOpenIssues: (repo) => fetchOpenIssues(repo, token),
    fetchReferenceState: (reference) => fetchReferenceState(reference, token),
  };
}

export async function fetchReferenceState(
  reference: GitHubReference,
  githubToken?: string,
): Promise<GitHubReferenceState | undefined> {
  const base = `https://api.github.com/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.name)}`;
  const detailPath =
    reference.urlKind === "pull"
      ? `pulls/${reference.number}`
      : `issues/${reference.number}`;
  try {
    const response = await fetch(`${base}/${detailPath}`, {
      headers: githubHeaders(githubToken),
    });
    if (!response.ok) return undefined;
    const data = (await response.json()) as {
      state?: unknown;
      merged?: unknown;
      merged_at?: unknown;
    };
    if (data.state !== "open" && data.state !== "closed") return undefined;
    return {
      state: data.state,
      merged: Boolean(data.merged) || Boolean(data.merged_at),
    };
  } catch {
    return undefined;
  }
}

function githubHeaders(githubToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "railway-opencode-discord-bot",
  };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
  return headers;
}

async function fetchGitHubMetadata(
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

async function fetchRepoDefaultBranch(
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
