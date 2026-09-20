import { deriveDashboardKeys, openSecret } from "../../shared/crypto";
import type { CredentialResolver, StateStore } from "./ports";

/**
 * Resolves the per-user git author and GitHub token configured in the
 * dashboard. Returns undefined when the deployment has no dashboard secret, so
 * sandboxes fall back to the global environment.
 */
export function createCredentialResolver(
  store: StateStore,
  secret: string | undefined,
): CredentialResolver | undefined {
  if (!secret) return undefined;
  const keysPromise = deriveDashboardKeys(secret);
  return async (task) => {
    if (!task.createdBy) return undefined;
    const settings = await store.getUserSettings(task.createdBy);
    if (!settings) return undefined;
    let githubToken: string | null = null;
    if (settings.hasToken) {
      const stored = await store.getUserSecret(task.createdBy);
      if (stored) {
        const keys = await keysPromise;
        githubToken =
          (await openSecret(keys.secretBox, stored.encryptedToken)) ?? null;
      }
    }
    return {
      gitAuthorName: settings.gitAuthorName,
      gitAuthorEmail: settings.gitAuthorEmail,
      githubToken,
      version: settings.updatedAt,
    };
  };
}
