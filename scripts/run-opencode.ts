import { Sandbox } from "railway";

const providerEnv: Record<string, string> = {};
if (Bun.env.ANTHROPIC_API_KEY) {
  providerEnv.ANTHROPIC_API_KEY = Bun.env.ANTHROPIC_API_KEY;
}
if (Bun.env.OPENROUTER_API_KEY) {
  providerEnv.OPENROUTER_API_KEY = Bun.env.OPENROUTER_API_KEY;
}

const model =
  Bun.env.OPENCODE_MODEL ??
  (providerEnv.OPENROUTER_API_KEY
    ? "openrouter/qwen/qwen3-coder"
    : "anthropic/claude-sonnet-4-6");
const prompt =
  process.argv.slice(2).join(" ") || "Reply with exactly: OpenCode is ready";

if (Object.keys(providerEnv).length === 0) {
  throw new Error(
    "ANTHROPIC_API_KEY or OPENROUTER_API_KEY must be set in .env",
  );
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const sandbox = await Sandbox.create({
  idleTimeoutMinutes: 10,
  env: providerEnv,
});

console.error(`sandbox=${sandbox.id}`);

try {
  await sandbox.files.mkdir("/root/workspace");
  await sandbox.files.write("/tmp/opencode-prompt.txt", prompt);

  const handle = sandbox.exec(
    [
      "bash -lc",
      shellQuote(
        `cd /root/workspace && prompt="$(cat /tmp/opencode-prompt.txt)" && exec opencode run --auto --format json --model ${shellQuote(model)} -- "$prompt"`,
      ),
    ].join(" "),
    {
      timeoutSec: 900,
      onStdout: (chunk) => process.stdout.write(chunk),
      onStderr: (chunk) => process.stderr.write(chunk),
    },
  );

  console.error(`execSession=${await handle.sessionName}`);

  const result = await handle;
  if (result.timedOut) console.error("OpenCode timed out");
  process.exitCode = result.exitCode ?? 1;
} finally {
  await sandbox.destroy().catch(() => {});
}
