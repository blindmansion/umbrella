import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExecHandle,
  ExecOptions,
  SandboxHandle,
  SandboxProvider,
} from "../../core/ports";

class LocalSandbox implements SandboxHandle {
  constructor(
    readonly id: string,
    private readonly root: string,
    private readonly env: Record<string, string>,
    private readonly onDestroy: () => void,
  ) {}

  exec(command: string, options: ExecOptions = {}): ExecHandle {
    const translated = this.translate(command);
    const cwd = this.translate(options.cwd ?? this.root);
    const promise = (async () => {
      await mkdir(cwd, { recursive: true });
      const process = Bun.spawn(["bash", "-lc", translated], {
        cwd,
        env: { ...Bun.env, ...this.env, ...options.env },
        stdout: "pipe",
        stderr: "pipe",
      });
      let timedOut = false;
      const timer = options.timeoutSec
        ? setTimeout(() => {
            timedOut = true;
            process.kill();
          }, options.timeoutSec * 1_000)
        : undefined;
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      if (timer) clearTimeout(timer);
      options.onStdout?.(stdout);
      options.onStderr?.(stderr);
      return { exitCode, stdout, stderr, timedOut };
    })() as ExecHandle;
    promise.sessionName = Promise.resolve(`local-${this.id}`);
    return promise;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const local = this.translate(path);
    await mkdir(join(local, ".."), { recursive: true });
    await writeFile(local, content);
  }

  async mkdir(path: string): Promise<void> {
    await mkdir(this.translate(path), { recursive: true });
  }

  async checkpoint(): Promise<void> {}

  destroy(): Promise<void> {
    this.onDestroy();
    return rm(this.root, { recursive: true, force: true });
  }

  private translate(value: string): string {
    const paths = value
      .replaceAll("/root/workspace", join(this.root, "workspace"))
      .replaceAll("/root/worktrees", join(this.root, "worktrees"))
      .replaceAll("/tmp/", `${join(this.root, "tmp")}/`);
    const opencode =
      "$(command -v opencode || printf 'bunx --yes opencode-ai')";
    return paths
      .replace("exec opencode run", `exec ${opencode} run`)
      .replace(/^opencode models$/, `${opencode} models`);
  }
}

export function createLocalSandboxProvider(): SandboxProvider {
  const sandboxes = new Map<string, LocalSandbox>();
  return {
    async create(options) {
      const root = await mkdtemp(join(tmpdir(), "umbrella-"));
      await mkdir(join(root, "tmp"), { recursive: true });
      const id = `local-${crypto.randomUUID()}`;
      const sandbox = new LocalSandbox(
        id,
        root,
        options.env,
        () => sandboxes.delete(id),
      );
      sandboxes.set(id, sandbox);
      return sandbox;
    },
    async connect(id) {
      const sandbox = sandboxes.get(id);
      if (!sandbox) throw new Error(`Local sandbox ${id} no longer exists`);
      return sandbox;
    },
    async restore() {
      throw new Error("Local sandboxes do not support checkpoints");
    },
    async listCheckpoints() {
      return [];
    },
    async deleteCheckpoint() {},
  };
}
