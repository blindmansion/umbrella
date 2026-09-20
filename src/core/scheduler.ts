export type ScheduledMaintenance = {
  /** Run the maintenance callback now, reusing an in-flight run. */
  runNow(): Promise<void>;
  stop(): void;
};

/**
 * Run a maintenance callback on a fixed interval, skipping a tick while the
 * previous run is still in flight so slow passes don't pile up.
 */
export function scheduleMaintenance(options: {
  intervalMs: number;
  run: () => Promise<unknown>;
  onError?: (error: unknown) => void;
}): ScheduledMaintenance {
  let running: Promise<void> | undefined;

  const runNow = (): Promise<void> => {
    if (running) return running;
    let started: Promise<unknown>;
    try {
      started = Promise.resolve(options.run());
    } catch (error) {
      started = Promise.reject(error);
    }
    running = started
      .then(
        () => undefined,
        (error) => {
          options.onError?.(error);
        },
      )
      .finally(() => {
        running = undefined;
      });
    return running;
  };

  const timer = setInterval(() => {
    void runNow();
  }, options.intervalMs);
  timer.unref?.();

  return { runNow, stop: () => clearInterval(timer) };
}
