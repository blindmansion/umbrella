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
