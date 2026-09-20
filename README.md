# Railway OpenCode Sandbox

This project explores running coding agents in short-lived Railway sandboxes and
streaming their activity to an application.

## What we know

- Railway's TypeScript SDK can create isolated Linux sandboxes, execute
  long-running commands, stream stdout and stderr, and reconnect to durable exec
  sessions.
- The default sandbox image includes OpenCode. The tested image reported
  OpenCode `1.18.31`.
- OpenCode accepts provider credentials from sandbox environment variables.
  `OPENROUTER_API_KEY` and `ANTHROPIC_API_KEY` were both detected successfully.
- `openrouter/qwen/qwen3-coder` was tested through OpenRouter and returned
  newline-delimited JSON events with `step_start`, `text`, and `step_finish`.
- `opencode run --format json` is the simplest interface for an MVP. Its JSONL
  output can be normalized by a backend and forwarded to a UI with
  Server-Sent Events.
- Provider secrets should be supplied through `Sandbox.create({ env })`, not
  per-command environment variables. Sandboxes are destroyed in `finally`
  blocks after each run.

## Basic goals

1. Accept a prompt from an application.
2. Create a prepared Railway sandbox and run OpenCode against a workspace.
3. Parse OpenCode's JSONL output into stable application events.
4. Stream those events to a UI while the agent works.
5. Support cancellation and eventual reconnection through Railway's durable
   exec session name.
6. Capture the agent's final response, status, usage, and repository changes,
   then clean up the sandbox.

## Current smoke test

Set the Railway credentials and at least one model-provider key in `.env`.
OpenRouter defaults to Qwen 3 Coder:

```env
RAILWAY_API_TOKEN=...
RAILWAY_ENVIRONMENT_ID=...
OPENROUTER_API_KEY=...
OPENCODE_MODEL=openrouter/qwen/qwen3-coder
```

Run a prompt:

```bash
bun run scripts/run-opencode.ts "Inspect the project and summarize it"
```

The script prints OpenCode's raw JSONL stream to stdout and diagnostic IDs to
stderr. `scripts/probe-opencode.ts` checks the sandbox's OpenCode installation,
provider detection, model availability, and authentication failure behavior.

