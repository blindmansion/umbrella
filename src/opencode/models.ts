import type { SandboxHandle } from "../core/ports";
import { SandboxManager } from "../core/sandboxes";

export async function getAvailableModels(
  manager: SandboxManager,
  channelId: string,
  sandbox: SandboxHandle,
  options: { refresh?: boolean; cacheTtlMs?: number } = {},
): Promise<string[]> {
  return manager.availableModels(channelId, sandbox, options);
}

export function clearModelCache(
  manager: SandboxManager,
  channelId?: string,
): void {
  manager.clearModelCache(channelId);
}
