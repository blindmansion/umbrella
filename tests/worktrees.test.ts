import { describe, expect, test } from "bun:test";
import {
  buildWorktreeCommand,
  sanitizeWorktreeId,
  worktreeBranchFor,
  worktreePathFor,
} from "../src/core/worktrees";

describe("worktree helpers", () => {
  test("sanitizes thread ids into filesystem-safe names", () => {
    expect(sanitizeWorktreeId("thread-1")).toBe("thread-1");
    expect(sanitizeWorktreeId("1234567890")).toBe("1234567890");
    expect(sanitizeWorktreeId("a/b c!")).toBe("a-b-c");
    expect(sanitizeWorktreeId("///")).toBe("session");
    expect(sanitizeWorktreeId("x".repeat(200)).length).toBe(64);
  });

  test("derives a worktree path and branch from the task branch", () => {
    expect(worktreePathFor("thread-1")).toBe("/root/worktrees/thread-1");
    expect(worktreeBranchFor("feat/42-fix-it", "thread-1")).toBe(
      "feat/42-fix-it-thread-1",
    );
    expect(worktreeBranchFor("main", "123")).toBe("main-123");
  });

  test("builds an idempotent worktree command", () => {
    const command = buildWorktreeCommand({
      path: "/root/worktrees/thread-1",
      branch: "feat/42-fix-it-thread-1",
      startPoint: "feat/42-fix-it",
    });

    expect(command).toContain("git worktree prune");
    expect(command).toContain("git worktree add -b");
    expect(command).toContain("'feat/42-fix-it-thread-1'");
    expect(command).toContain("'/root/worktrees/thread-1'");
    expect(command).toContain("'feat/42-fix-it'");
    expect(command).toContain("if [ -d '/root/worktrees/thread-1' ]; then exit 0; fi");
  });

  test("quotes values that contain shell metacharacters", () => {
    const command = buildWorktreeCommand({
      path: "/root/worktrees/it's",
      branch: "b",
      startPoint: "s",
    });
    expect(command).toContain("/root/worktrees/it'\\''s'");
  });
});
