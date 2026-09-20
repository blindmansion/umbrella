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
};
