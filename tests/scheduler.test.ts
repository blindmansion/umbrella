import { describe, expect, test } from "bun:test";
import { scheduleMaintenance } from "../src/core/scheduler";

describe("scheduleMaintenance", () => {
  test("reuses an in-flight run and stops on request", async () => {
    let runs = 0;
    let release: (() => void) | undefined;
    const scheduled = scheduleMaintenance({
      intervalMs: 10_000,
      run: async () => {
        runs += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });

    const first = scheduled.runNow();
    const second = scheduled.runNow();
    expect(runs).toBe(1);

    release?.();
    await Promise.all([first, second]);
    expect(runs).toBe(1);
    scheduled.stop();
  });

  test("reports errors without rejecting", async () => {
    const errors: unknown[] = [];
    const scheduled = scheduleMaintenance({
      intervalMs: 1_000,
      run: async () => {
        throw new Error("boom");
      },
      onError: (error) => errors.push(error),
    });

    await scheduled.runNow();
    scheduled.stop();
    expect(errors).toHaveLength(1);
  });
});
