import type { Sandbox } from "railway";
import { listOpenCodeModels } from "./runner";

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1_000;

type ModelCacheEntry = {
  models: string[];
  fetchedAt: number;
};

const cache = new Map<string, ModelCacheEntry>();
const inFlight = new Map<string, Promise<string[]>>();

export function clearModelCache(channelId?: string): void {
  if (channelId === undefined) {
    cache.clear();
    return;
  }
  cache.delete(channelId);
}

export async function getAvailableModels(
  channelId: string,
  sandbox: Sandbox,
  options: { refresh?: boolean; cacheTtlMs?: number } = {},
): Promise<string[]> {
  const cached = cache.get(channelId);
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  if (
    cached &&
    !options.refresh &&
    Date.now() - cached.fetchedAt < cacheTtlMs
  ) {
    return cached.models;
  }

  const pending = inFlight.get(channelId);
  if (pending) return pending;

  const request = listOpenCodeModels(sandbox)
    .then((models) => {
      cache.set(channelId, { models, fetchedAt: Date.now() });
      return models;
    })
    .catch((error) => {
      console.warn(
        `Could not list OpenCode models for channel ${channelId}:`,
        error instanceof Error ? error.message : String(error),
      );
      return cached?.models ?? [];
    })
    .finally(() => {
      inFlight.delete(channelId);
    });

  inFlight.set(channelId, request);
  return request;
}
