import { Sandbox } from "railway";

const token = Bun.env.RAILWAY_API_TOKEN;
const environmentId = Bun.env.RAILWAY_ENVIRONMENT_ID;

if (!token || !environmentId) {
  throw new Error(
    "RAILWAY_API_TOKEN and RAILWAY_ENVIRONMENT_ID must be set in .env",
  );
}

const sandbox = await Sandbox.create({ token, environmentId });

const { stdout } = await sandbox.exec("echo hello");
console.log(stdout);

await sandbox.destroy();