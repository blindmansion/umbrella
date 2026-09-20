import { randomUUID } from "node:crypto";
import type { SandboxHandle } from "./ports";
import { shellQuote } from "./utils";

export type ProgressEvent =
  | { type: "step_start" }
  | {
      type: "tool_use";
      tool: string;
      status: string;
      title?: string;
      input?: Record<string, unknown>;
    }
  | { type: "error" };

export async function runOpenCode(options: {
  sandbox: SandboxHandle;
  model: string;
  prompt: string;
  sessionId?: string;
  onProgress: (event: ProgressEvent) => void | Promise<void>;
}): Promise<{ text: string; sessionId?: string }> {
  const { sandbox, model, prompt, sessionId, onProgress } = options;
  const textParts: string[] = [];
  const stderrParts: string[] = [];
  const promptPath = `/tmp/opencode-prompt-${randomUUID()}.txt`;
  let stdoutBuffer = "";
  let discoveredSessionId: string | undefined;
  let progressQueue = Promise.resolve();
  const sessionFlag = sessionId
    ? ` --session ${shellQuote(sessionId)}`
    : "";
  const queueProgress = (event: ProgressEvent) => {
    progressQueue = progressQueue
      .then(() => onProgress(event))
      .catch((error) =>
        console.error("Could not send progress update:", error),
      );
  };

  await sandbox.mkdir("/root/workspace");
  await sandbox.writeFile(promptPath, prompt);
  const handle = sandbox.exec(
    [
      "bash -lc",
      shellQuote(
        `cd /root/workspace && prompt="$(cat ${shellQuote(promptPath)})" && rm -f ${shellQuote(promptPath)} && exec opencode run --auto --format json --model ${shellQuote(model)}${sessionFlag} -- "$prompt"`,
      ),
    ].join(" "),
    {
      timeoutSec: 900,
      onStdout: (chunk) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          discoveredSessionId =
            collectOpenCodeEvent(line, textParts, queueProgress) ??
            discoveredSessionId;
        }
      },
      onStderr: (chunk) => stderrParts.push(chunk),
    },
  );

  if (handle.sessionName) {
    console.log(`OpenCode exec session ${await handle.sessionName}`);
  }
  const result = await handle;
  if (stdoutBuffer.trim()) {
    discoveredSessionId =
      collectOpenCodeEvent(stdoutBuffer, textParts, queueProgress) ??
      discoveredSessionId;
  }
  await progressQueue;

  if (result.timedOut) throw new Error("OpenCode timed out");
  if (result.exitCode !== 0) {
    throw new Error(
      stderrParts.join("").trim() ||
        result.stderr.trim() ||
        `OpenCode exited with code ${result.exitCode}`,
    );
  }
  const text = textParts.join("").trim();
  if (!text) throw new Error("OpenCode returned no text");
  return { text, sessionId: discoveredSessionId };
}

function collectOpenCodeEvent(
  line: string,
  textParts: string[],
  onProgress: (event: ProgressEvent) => void,
): string | undefined {
  if (!line.trim()) return undefined;
  try {
    const event = JSON.parse(line) as {
      type?: string;
      text?: string;
      part?: {
        text?: string;
        tool?: string;
        state?: {
          status?: string;
          title?: string;
          input?: Record<string, unknown>;
        };
      };
      sessionID?: string;
    };
    if (event.type === "text") {
      const text = event.part?.text ?? event.text;
      if (text) textParts.push(text);
    } else if (event.type === "step_start") {
      onProgress({ type: "step_start" });
    } else if (event.type === "tool_use") {
      onProgress({
        type: "tool_use",
        tool: event.part?.tool ?? "tool",
        status: event.part?.state?.status ?? "completed",
        title: event.part?.state?.title,
        input: event.part?.state?.input,
      });
    } else if (event.type === "error") {
      onProgress({ type: "error" });
    }
    return event.sessionID;
  } catch {
    console.warn("Ignoring non-JSON OpenCode output:", line);
    return undefined;
  }
}

export async function listOpenCodeModels(
  sandbox: SandboxHandle,
  options: { timeoutSec?: number } = {},
): Promise<string[]> {
  const result = await sandbox.exec("opencode models", {
    cwd: "/root/workspace",
    timeoutSec: options.timeoutSec ?? 60,
  });
  if (result.timedOut) throw new Error("Listing OpenCode models timed out");
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() ||
        `opencode models exited with code ${result.exitCode}`,
    );
  }
  return parseModelList(result.stdout);
}

export function parseModelList(output: string): string[] {
  return [
    ...new Set(
      output
        .split("\n")
        .map((line) => line.trim())
        .filter(
          (line) =>
            Boolean(line) &&
            !/\s/.test(line) &&
            /^[^/\s]+\/[^\s]+$/.test(line),
        ),
    ),
  ];
}
