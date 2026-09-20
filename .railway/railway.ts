import {
  defineRailway,
  github,
  group,
  postgres,
  preserve,
  project,
  service,
} from "railway/iac";

export default defineRailway(() => {
  const umbrellaDatabase = postgres("umbrella-postgres");
  const phoenixDatabase = postgres("phoenix-postgres");

  const bot = service("umbrella", {
    source: github("blindmansion/umbrella", { branch: "main" }),
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile.bot",
    },
    deploy: {
      restartPolicyType: "ALWAYS",
    },
    env: {
      DATABASE_URL: umbrellaDatabase.env.DATABASE_URL,
      DISCORD_BOT_TOKEN: preserve(),
      RAILWAY_API_TOKEN: preserve(),
      ANTHROPIC_API_KEY: preserve(),
      FIREWORKS_API_KEY: preserve(),
      GITHUB_TOKEN: preserve(),
      GIT_AUTHOR_NAME: preserve(),
      GIT_AUTHOR_EMAIL: preserve(),
      OPENCODE_MODEL: preserve(),
      TYPESAFE_API_KEY: preserve(),
      TYPESAFE_MODEL: preserve(),
      INTENT_CONFIDENCE_THRESHOLD: preserve(),
      TASK_RECONCILE_INTERVAL_MINUTES: preserve(),
      PHOENIX_ENDPOINT: "http://phoenix.railway.internal:6006",
      PHOENIX_API_KEY: preserve(),
      PHOENIX_LOG_CONTENT: preserve(),
      SANDBOX_NETWORK_ISOLATION: "PRIVATE",
    },
  });

  const phoenix = service("phoenix", {
    source: github("blindmansion/umbrella", { branch: "main" }),
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile.phoenix",
      watchPatterns: ["Dockerfile.phoenix"],
    },
    deploy: {
      healthcheckPath: "/readyz",
      healthcheckTimeout: 300,
      restartPolicyType: "ALWAYS",
    },
    env: {
      PORT: "6006",
      PHOENIX_PORT: "6006",
      PHOENIX_GRPC_PORT: "4317",
      PHOENIX_HOST: "0.0.0.0",
      PHOENIX_SQL_DATABASE_URL: phoenixDatabase.env.DATABASE_URL,
      PHOENIX_ENABLE_AUTH: "true",
      PHOENIX_SECRET: preserve(),
      PHOENIX_DEFAULT_ADMIN_INITIAL_PASSWORD: preserve(),
    },
  });

  return project("umbrella", {
    resources: [
      group("Umbrella", [bot, umbrellaDatabase]),
      group("Observability", [phoenix, phoenixDatabase]),
    ],
  });
});
