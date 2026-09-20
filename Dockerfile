# syntax=docker/dockerfile:1

# Install dependencies in a throwaway layer so production layers stay slim and
# rebuilds only re-run `bun install` when the manifest changes.
FROM oven/bun:1-alpine AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY index.ts opencode.ts sandboxes.ts store.ts tasks.ts tracing.ts ./
# State lives in PostgreSQL, so the image is read-only at runtime. Own /app by
# the unprivileged `bun` user so any incidental writes still succeed.
RUN chown -R bun:bun /app
USER bun

CMD ["bun", "run", "index.ts"]
