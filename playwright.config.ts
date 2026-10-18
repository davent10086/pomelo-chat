import { defineConfig } from "@playwright/test";

if (!process.env.DATABASE_URL_TEST || !process.env.REDIS_URL_TEST)
  throw new Error(
    "Browser tests require isolated DATABASE_URL_TEST and REDIS_URL_TEST",
  );
export default defineConfig({
  testDir: "./qa/playwright",
  outputDir: "./test-results/browser",
  testMatch: ["system-regressions.e2e.spec.ts", "chat-recovery-search.e2e.spec.ts", "assistant-interactions.e2e.spec.ts", "address-book.e2e.spec.ts", "real-chat.e2e.spec.ts", "message-overload.e2e.spec.ts", ...(process.env.TEST_RTC === '1' ? ['real-rtc.e2e.spec.ts'] : [])],
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:5199",
    headless: true,
    trace: "retain-on-failure",
    ...(process.env.TEST_RTC === '1' ? {
      permissions: ['camera', 'microphone'],
      launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] },
    } : {}),
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
        REDIS_KEY_PREFIX: process.env.TEST_REDIS_KEY_PREFIX || "browser-regression:",
        ...(process.env.UPLOAD_ROOT ? { UPLOAD_ROOT: process.env.UPLOAD_ROOT } : {}),
        JWT_SECRET: "browser-regression-secret",
        METRICS_TOKEN: "browser-metrics-test",
        DEEPSEEK_API_KEY: "",
        REQUEST_LOGS: "false",
        // Functional fixtures share one IP; production keeps its default limit.
        API_RATE_LIMIT_MAX: "10000",
        // Bulk fixture generation; default admission is covered by test:message-overload.
        MESSAGE_USER_RATE: "10000",
        MESSAGE_USER_BURST: "10000",
        MESSAGE_PRIVATE_RATE: "10000",
        MESSAGE_PRIVATE_BURST: "10000",
        MESSAGE_GROUP_RATE: "10000",
        MESSAGE_GROUP_BURST: "10000",
        MESSAGE_GLOBAL_RATE: "10000",
        MESSAGE_GLOBAL_BURST: "10000",
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
