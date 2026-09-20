# Umbrella

Umbrella is a Discord bot that turns GitHub issues and pull requests into task
channels backed by short-lived Railway sandboxes. Each Discord thread keeps an
OpenCode session, while all threads in a task channel share one repository
checkout and branch.

Umbrella is developed on Railway. The repository defines the complete
production stack as code:

- the Umbrella bot, built with `Dockerfile.bot`
- Arize Phoenix, built with `Dockerfile.phoenix`
- separate managed PostgreSQL databases for Umbrella and Phoenix
- GitHub sources pinned to `main`, so merges redeploy the running instance

## Railway quickstart

Prerequisites:

- a Railway account and the Railway CLI
- a Discord application with the privileged **Message Content** intent enabled
- an account-scoped Railway API token for creating sandboxes
- an Anthropic or Fireworks API key
- the Railway GitHub App authorized for `blindmansion/umbrella`

Clone the repository and install its dependencies:

```bash
git clone https://github.com/blindmansion/umbrella.git
cd umbrella
bun install --frozen-lockfile
```

The official Railway `use-railway` skill is checked into
`.agents/skills/use-railway`. Restore its Cursor/OpenCode links after cloning:

```bash
npx skills experimental_install
```

Create or link a Railway project, then review and apply the infrastructure:

```bash
railway login
railway init --name umbrella
bun run railway:plan
bun run railway:apply
```

If the project already exists, use `railway link --project umbrella` instead of
`railway init`. The plan creates four services: `umbrella`,
`umbrella-postgres`, `phoenix`, and `phoenix-postgres`.

Set the bot secrets. At least one model-provider key is required:

```bash
railway variable set \
  DISCORD_BOT_TOKEN=... \
  RAILWAY_API_TOKEN=... \
  GITHUB_TOKEN=... \
  ANTHROPIC_API_KEY=... \
  TYPESAFE_API_KEY=... \
  --service umbrella
```

`FIREWORKS_API_KEY` can replace `ANTHROPIC_API_KEY`. Optional variables are
`OPENCODE_MODEL`, `TYPESAFE_MODEL`, `INTENT_CONFIDENCE_THRESHOLD`,
`GIT_AUTHOR_NAME`, and `GIT_AUTHOR_EMAIL`.

Enable Phoenix authentication with generated secrets:

```bash
railway variable set \
  PHOENIX_SECRET="$(openssl rand -hex 32)" \
  PHOENIX_DEFAULT_ADMIN_INITIAL_PASSWORD="replace-with-a-strong-password" \
  --service phoenix
```

Generate a public domain for the Phoenix service from Railway's Networking
settings. Phoenix listens on port `6006`; OTLP/gRPC listens privately on
`4317`.

The infrastructure wires the bot to Phoenix over Railway's private network
(`PHOENIX_ENDPOINT=http://phoenix.railway.internal:6006` and
`SANDBOX_NETWORK_ISOLATION=PRIVATE`). Log into the Phoenix domain as
`admin@localhost`, create a system API key under **Settings → API Keys**, and
share it with the bot so sandboxes can export:

```bash
railway variable set \
  PHOENIX_API_KEY=... \
  --service umbrella
```

Without `PHOENIX_API_KEY` the bot still exports to an auth-less Phoenix, but
authenticated deployments need it.

The databases are connected through Railway's private network. Umbrella creates
its `tasks` and `sessions` tables during startup. Existing SQLite files are not
imported; a first Railway deployment starts with empty state.

After setup, every merge to `main` triggers a new Umbrella build and replaces
the running bot when the deployment is healthy. Changes outside
`Dockerfile.phoenix` do not rebuild Phoenix.

## Development

Development runs against the Railway project rather than a local stack. Link the
project and run the bot with `railway run` so `DATABASE_URL`,
`PHOENIX_ENDPOINT`, and the other service variables are injected from the
deployed environment:

```bash
railway link
railway run bun run dev
```

Ship changes by merging to `main`; Railway rebuilds and replaces the bot.

## Discord usage

Share a GitHub issue or pull request URL in any channel and the bot creates a
task channel, provisions its sandbox, and replies with a link. Issue URLs
default to feature work and pull request URLs default to review work. In a task
channel, ask the bot to work on something and it starts a thread; each thread is
one OpenCode session. Ask to reset a thread to start a fresh session in the same
sandbox, reset the task channel to rebuild the sandbox and invalidate all thread
sessions, or close the task to destroy its sandbox and archive active threads
while preserving channel history.

Requests that don't have a GitHub issue or pull request run against the
server's configured repository. An admin sets it once with
`/repo set blindmansion/umbrella` (and can inspect it with `/repo show` or
remove it with `/repo clear`). After that, mention the bot with a question or
request in any channel—or just ask confidently enough for intent
classification to pick it up—and the bot creates a task channel in that
repository, provisions a sandbox on its default branch, and starts a session
with what you asked. `/task` also accepts a `repo` option for a one-off
repository, and its `url` option is now optional.

These ad-hoc sessions clone the default branch and let the agent decide what to
do next. The bot doesn't pre-create a branch or open a pull request; the agent
branches, commits, pushes, and opens a pull request as needed.

The `/task` and `/close` commands and `@umbrella` mentions still work as
explicit overrides; they are no longer required. See
[Intent classification](#intent-classification).

The Discord invite needs the `bot` and `applications.commands` scopes plus View
Channel, Send Messages, Read Message History, Create Public Threads, Send
Messages in Threads, Manage Channels, and Manage Messages permissions.

## Intent classification

With `TYPESAFE_API_KEY` set, every guild message (plus the surrounding
conversation) is classified by [TypeSafe jev](https://docs.typesafe.ai) before
the bot decides what to do. The classifier asks two questions:

- a **noul** question for whether the latest message is directed at the bot
- a **choice** question for the intended action: `chat`, `create_task`, `reset`,
  `close`, or `ignore`

`create_task` covers both GitHub issue/pull request URLs and requests that run
against the server's configured repository (see [Discord usage](#discord-usage)).
The bot acts without an explicit mention when the direction score and the
action's confidence both clear `INTENT_CONFIDENCE_THRESHOLD` (default `0.6`);
`reset` and `close` require a little more confidence because they destroy state.
Mentions bypass the gate, and low-confidence messages are left alone. Without
`TYPESAFE_API_KEY`, the bot falls back to mention-only behavior.

Replies to the bot count as directed at it, so answering a question the bot
asked continues the session without a mention. When the bot does respond, any
messages it stayed silent on since its last reply are forwarded with the prompt,
and a bare `@umbrella` means "respond to what I just said".

`TYPESAFE_MODEL` selects the model and defaults to `jev-latest`. Classifier
failures are logged and ignored; the mention-only fallback still applies. Every
decision is logged as `Intent for message <id>: ... -> <action|silent>` with the
scores, which is the place to look when the bot responds or stays quiet
unexpectedly.

## Phoenix tracing

Every task channel exports its OpenCode sessions to a self-hosted
[Arize Phoenix](https://github.com/Arize-ai/phoenix) instance. Traces are
grouped into one project per repository (for example `blindmansion-umbrella`).
Tasks that aren't tied to a GitHub issue or pull request are general questions,
so they share a project named after the Discord server instead.

### Phoenix and the bot

Railway runs Phoenix with authentication enabled and its own managed Postgres,
as defined in `.railway/railway.ts`. After the first boot, log in as
`admin@localhost` on the Phoenix domain, set a new password, and create a system
API key under **Settings → API Keys**. Set `PHOENIX_API_KEY` to that key so
sandboxes authenticate their exports.

### Connecting sandboxes to Phoenix

The bot passes a single `PHOENIX_ENDPOINT` down to each sandbox, so it must be a
URL Railway sandboxes can reach. On Railway's private network, run Phoenix as a
service in the same environment and use its internal address:

```env
PHOENIX_ENDPOINT=http://phoenix.railway.internal:6006
SANDBOX_NETWORK_ISOLATION=PRIVATE
PHOENIX_API_KEY=...
```

Without `PHOENIX_ENDPOINT` the bot logs that tracing is disabled and runs
sessions untraced.

Spans include prompts, responses, and tool input and output. Set
`PHOENIX_LOG_CONTENT=false` to export span structure only, with content
replaced by `<redacted (N chars)>` placeholders.

### How it works

On sandbox creation the bot installs the
[Arize OpenCode tracing harness](https://github.com/Arize-ai/coding-harness-tracing/tree/main/tracing/opencode)
non-interactively. The installer only takes a project name from the dotenv file
named by `ARIZE_ENV_FILE`, and it redacts all content unless the
`ARIZE_LOG_*` flags are set, so the bot supplies both. Tracing settings are
written when a sandbox is built; changing them rebuilds existing sandboxes on
their next prompt. OpenCode
loads the harness plugin and exports OpenInference spans directly to Phoenix.
Tracing is best-effort: a failed install logs a warning and the session
continues untraced.


