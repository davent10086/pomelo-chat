import { defineConfig } from "@playwright/test";

if (!process.env.DATABASE_URL_TEST || !process.env.REDIS_URL_TEST)
  throw new Error(
    "Browser tests require isolated DATABASE_URL_TEST and REDIS_URL_TEST",
  );
export default defineConfig({
  testDir: "./qa/playwright",
  testMatch: ["system-regressions.e2e.spec.ts", "chat-recovery-search.e2e.spec.ts"],
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:5199",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node -r ts-node/register/transpile-only src/index.ts",
      cwd: "./server",
      url: "http://127.0.0.1:3199/api/chat/v1/message/chat_list",
      timeout: 60000,
      env: {
        CORS_ORIGINS: "http://127.0.0.1:5199",
        NODE_ENV: "test",
        PORT: "3199",
        REDIS_URL: process.env.REDIS_URL_TEST,
        REDIS_KEY_PREFIX: "browser-regression:",
        JWT_SECRET: "browser-regression-secret",
        DEEPSEEK_API_KEY: "",
        REQUEST_LOGS: "false",
      },
    },
    {
      command:
        "pnpm --filter pomelo-chat-client dev --host 127.0.0.1 --port 5199",
      url: "http://127.0.0.1:5199",
      timeout: 60000,
      env: {
        VITE_API_BASE: "http://127.0.0.1:3199/api/chat/v1",
        VITE_WS_BASE: "ws://127.0.0.1:3199/api/chat/v1",
        VITE_SERVER_URL: "http://127.0.0.1:3199",
      },
    },
  ],
});
