import type { GitHubClient } from "../../core/ports";
import {
  fetchGitHubMetadata,
  fetchOpenIssues,
  fetchRepoDefaultBranch,
} from "../../tasks/github";

export function createGitHubClient(token?: string): GitHubClient {
  return {
    fetchMetadata: (reference) => fetchGitHubMetadata(reference, token),
    fetchDefaultBranch: (repo) => fetchRepoDefaultBranch(repo, token),
    fetchOpenIssues: (repo) => fetchOpenIssues(repo, token),
  };
}
