import { Sandbox } from "railway";

const sandbox = await Sandbox.create({
  idleTimeoutMinutes: 5,
  env: { ANTHROPIC_API_KEY: "invalid-probe-key" },
});

console.log(`sandbox=${sandbox.id}`);

async function probe(label: string, command: string, timeoutSec = 60) {
  const result = await sandbox.exec(command, { timeoutSec });
  console.log(`\n[${label}] exit=${result.exitCode} timedOut=${result.timedOut}`);
  if (result.stdout.trim()) console.log(result.stdout.trim());
  if (result.stderr.trim()) console.error(result.stderr.trim());
}

try {
  await probe("version", "opencode --version");
  await probe("auth", "opencode auth list");
  await probe("auth help", "opencode auth login --help");
  await probe("anthropic models", "opencode models anthropic");
  await probe(
    "provider environment",
    `for key in ANTHROPIC_API_KEY OPENAI_API_KEY GOOGLE_GENERATIVE_AI_API_KEY GROQ_API_KEY OPENROUTER_API_KEY; do
      if [ -n "$(printenv "$key")" ]; then echo "$key=set"; else echo "$key=unset"; fi
    done`,
  );
  await probe(
    "invalid-key run",
    `opencode run --format json --model anthropic/claude-sonnet-4-6 -- "Reply with exactly: ready"`,
    90,
  );
} finally {
  await sandbox.destroy().catch(() => {});
}
