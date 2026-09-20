export class ChannelQueue {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly depths = new Map<string, number>();

  async runExclusive<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(channelId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(channelId, tail);
    this.depths.set(channelId, this.depth(channelId) + 1);
    try {
      return await result;
    } finally {
      const remaining = this.depth(channelId) - 1;
      if (remaining > 0) this.depths.set(channelId, remaining);
      else this.depths.delete(channelId);
      if (this.queues.get(channelId) === tail) this.queues.delete(channelId);
    }
  }

  depth(channelId: string): number {
    return this.depths.get(channelId) ?? 0;
  }
}
