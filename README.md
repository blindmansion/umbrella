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

The databases are connected through Railway's private network. Umbrella creates
its `tasks` and `sessions` tables during startup. Existing SQLite files are not
imported; a first Railway deployment starts with empty state.

After setup, every merge to `main` triggers a new Umbrella build and replaces
the running bot when the deployment is healthy. Changes outside
`Dockerfile.phoenix` do not rebuild Phoenix.

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

