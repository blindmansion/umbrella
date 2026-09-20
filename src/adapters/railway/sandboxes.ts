import { Sandbox } from "railway";
import type {
  ExecHandle,
  ExecOptions,
  ExecResult,
  SandboxHandle,
  SandboxProvider,
} from "../../core/ports";

function wrap(sandbox: Sandbox): SandboxHandle {
  return {
    id: sandbox.id,
    exec(command: string, options?: ExecOptions): ExecHandle {
      const raw = sandbox.exec(command, options);
      const promise = Promise.resolve(raw) as ExecHandle;
      const sessionName = (raw as { sessionName?: Promise<string> }).sessionName;
      if (sessionName) promise.sessionName = sessionName;
      return promise as Promise<ExecResult> & { sessionName?: Promise<string> };
    },
    mkdir(path: string) {
      return sandbox.files.mkdir(path);
    },
    writeFile(path: string, content: string) {
      return sandbox.files.write(path, content);
    },
    async checkpoint(name: string) {
      await sandbox.checkpoint(name);
    },
    destroy() {
      return sandbox.destroy();
    },
  };
}

export const railwaySandboxProvider: SandboxProvider = {
  async create(options) {
    return wrap(await Sandbox.create(options));
  },
  async connect(id) {
    return wrap(await Sandbox.connect(id));
  },
  async restore(name, options) {
    return wrap(await Sandbox.create(name, options));
  },
  async listCheckpoints() {
    const checkpoints = await Sandbox.checkpoints();
    return checkpoints.map((checkpoint) => ({
      id: checkpoint.id,
      key: checkpoint.key,
    }));
  },
  async deleteCheckpoint(id) {
    await Sandbox.deleteCheckpoint(id);
  },
};
