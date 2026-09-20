const channelQueues = new Map<string, Promise<unknown>>();
const channelQueueDepths = new Map<string, number>();

export function runExclusive<T>(
  channelId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = channelQueues.get(channelId) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(fn);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );

  channelQueues.set(channelId, tail);
  channelQueueDepths.set(channelId, queueDepth(channelId) + 1);

  return result.finally(() => {
    const remaining = queueDepth(channelId) - 1;
    if (remaining > 0) {
      channelQueueDepths.set(channelId, remaining);
    } else {
      channelQueueDepths.delete(channelId);
    }
    if (channelQueues.get(channelId) === tail) {
      channelQueues.delete(channelId);
    }
  });
}

export function queueDepth(channelId: string): number {
  return channelQueueDepths.get(channelId) ?? 0;
}
