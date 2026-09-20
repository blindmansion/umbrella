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

## Discord bot usage

Configure the bot and Railway sandbox credentials in `.env`:

```env
DISCORD_BOT_TOKEN=...
RAILWAY_API_TOKEN=...
RAILWAY_ENVIRONMENT_ID=...
ANTHROPIC_API_KEY=...
# Or use FIREWORKS_API_KEY instead of ANTHROPIC_API_KEY.
# GITHUB_TOKEN is optional, but recommended for private repositories and
# higher GitHub API rate limits.
GITHUB_TOKEN=...
# OPENCODE_MODEL is optional.
OPENCODE_MODEL=...
```

Use `/task url:<github-issue-or-pr-url>` to create a task channel and eagerly
provision its sandbox. The optional `kind` is `planning`, `feature`, `bugfix`,
or `review`; issue URLs default to `feature` and pull request URLs default to
`review`. Feature branches default to `feat/<number>-<title>`, reviews use the
pull request head branch, and planning or bugfix tasks use the repository's
default branch. The optional `branch` overrides these defaults. Use `/close`
inside a task channel to destroy its sandbox, archive its active threads, and
retain the channel history.

Mention the bot with a prompt in a task channel to fork a new thread. Each
thread is one OpenCode session, while every thread in the channel shares the
task's sandbox and branch. Sending `reset` in a thread starts a new OpenCode
session in that same sandbox. Mentioning the bot with `reset` in the task
channel destroys the sandbox and invalidates every thread session; the next
prompt rebuilds it.

Enable the privileged **Message Content** intent for the bot in Discord's
developer portal. The invite needs the `bot` and `applications.commands`
scopes plus View Channel, Send Messages, Read Message History, Create Public
Threads, Send Messages in Threads, Manage Channels, and Manage Messages
permissions.

