import { startBot } from "./adapters/discord/bot";
import { createGitHubClient } from "./adapters/github/client";
import { railwaySandboxProvider } from "./adapters/railway/sandboxes";
import { createStore } from "./adapters/postgres/store";
import { createIntentClassifier } from "./adapters/typesafe/classifier";
import { loadConfig } from "./config";
import { createUmbrella } from "./core/umbrella";

const config = loadConfig();
const store = await createStore();
const github = createGitHubClient(config.githubToken);

await startBot({
  token: config.token,
  store,
  github,
  config,
  createRuntime: (chat) =>
    createUmbrella({
      store,
      chat,
      sandboxes: railwaySandboxProvider,
      classifier: config.intent
        ? createIntentClassifier({
            apiKey: config.intent.apiKey,
            model: config.intent.model,
          })
        : undefined,
      github,
      config,
    }),
});
