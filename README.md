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
  --service umbrella
```

`FIREWORKS_API_KEY` can replace `ANTHROPIC_API_KEY`. Optional variables are
`OPENCODE_MODEL`, `GIT_AUTHOR_NAME`, and `GIT_AUTHOR_EMAIL`.

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

## Local development

`bun run dev` starts the bundled Postgres and an auth-less Phoenix with
`docker-compose.yml`, then runs the bot on the host. Point `DATABASE_URL` at the
compose Postgres (`postgres://umbrella:umbrella@localhost:5432/umbrella`) and
set `PHOENIX_ENDPOINT` to a URL the sandboxes can reach. From a developer
machine that usually means a tunnel to Phoenix, since sandboxes run on Railway.


## Discord usage

Use `/task url:<github-issue-or-pr-url>` to create a task channel and provision
its sandbox. Issue URLs default to feature work and pull request URLs default
to review work. Use `/close` in a task channel to destroy its sandbox and
archive active threads while preserving channel history.

Mention the bot in a task channel to create a thread. Each thread is one
OpenCode session. Send `reset` in a thread to start a fresh session in the same
sandbox, or mention the bot with `reset` in the task channel to rebuild the
sandbox and invalidate all thread sessions.

The Discord invite needs the `bot` and `applications.commands` scopes plus View
Channel, Send Messages, Read Message History, Create Public Threads, Send
Messages in Threads, Manage Channels, and Manage Messages permissions.

## Phoenix tracing

Every task channel exports its OpenCode sessions to its own project in a
self-hosted [Arize Phoenix](https://github.com/Arize-ai/phoenix) instance. The
project name is derived from the repository and reference (for example
`umbrella-blindmansion-umbrella-5`), so a channel's traces stay isolated and
survive sandbox rebuilds.

### Phoenix and the bot

`docker-compose.yml` runs the latest Phoenix with a persistent volume and
authentication disabled, alongside a Postgres for the bot. `docker-compose.prod.yml`
extends it, turning authentication on and adding the bot service:

```bash
# Development Postgres + Phoenix, then the bot on the host
bun run dev

# Phoenix with auth plus the containerized bot
PHOENIX_SECRET=change-me-32-chars-min-1-digit-1-lower \
PHOENIX_DEFAULT_ADMIN_INITIAL_PASSWORD=strong-admin-password \
bun run prod
```

After the first authenticated boot, log in as `admin@localhost`, set a new
password, and create a system API key under **Settings → API Keys**. Set
`PHOENIX_API_KEY` to that key so sandboxes authenticate their exports.

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

### How it works

On sandbox creation the bot installs the
[Arize OpenCode tracing harness](https://github.com/Arize-ai/coding-harness-tracing/tree/main/tracing/opencode)
non-interactively and writes `ARIZE_PROJECT_NAME` for the task channel. OpenCode
loads the harness plugin and exports OpenInference spans directly to Phoenix.
Tracing is best-effort: a failed install logs a warning and the session
continues untraced.


