function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const env = {
  port: num(Bun.env.DASHBOARD_PORT ?? Bun.env.PORT, 8787),
  databaseUrl: Bun.env.DATABASE_URL ?? "",
  electricUrl: (Bun.env.ELECTRIC_URL ?? "http://localhost:3000").replace(
    /\/+$/,
    "",
  ),
  electricSecret: Bun.env.ELECTRIC_SECRET ?? "",
  dashboardSecret: Bun.env.DASHBOARD_SECRET ?? "",
  // Magic links and cookies must be Secure in production; local development
  // over plain HTTP needs to disable it.
  secureCookies:
    Bun.env.NODE_ENV === "production" ||
    Bun.env.DASHBOARD_SECURE_COOKIES === "true",
};

export function assertEnv(): void {
  const missing = [
    ["DATABASE_URL", env.databaseUrl],
    ["DASHBOARD_SECRET", env.dashboardSecret],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }
}
