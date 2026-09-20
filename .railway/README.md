# Railway infrastructure

`.railway/railway.ts` is the source of truth for the production project. It
defines the Umbrella bot, Phoenix, and a separate managed PostgreSQL database
for each service.

Preview changes with `bun run railway:plan`. Apply only after reviewing that
plan with `bun run railway:apply`. Railway deploys both source services from
the `main` branch; subsequent merges rebuild the running Umbrella service.
