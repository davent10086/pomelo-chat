import path from 'node:path';
import { defineConfig } from '@playwright/test';

if (!process.env.DATABASE_URL_TEST || !process.env.REDIS_URL_TEST || !process.env.TEST_API_PORT || !process.env.TEST_WEB_PORT)
  throw new Error('Use pnpm test:e2e / pnpm test:rtc: the test runner allocates isolated services and ports');
const apiOrigin = process.env.TEST_API_ORIGIN!;
const webOrigin = process.env.TEST_WEB_ORIGIN!;
const apiPort = process.env.TEST_API_PORT!;
const webPort = process.env.TEST_WEB_PORT!;
const layer = process.env.TEST_LAYER || 'e2e';
const source = layer === 'rtc' ? 'tests/special/rtc' : layer === 'ai-live' ? 'tests/special/ai-live' : 'tests/e2e';
const node = `"${process.execPath}"`;

export default defineConfig({
  testDir: `./${source}`,
  testMatch: '**/*.e2e.spec.ts',
  projects: [{ name: layer }],
  outputDir: process.env.TEST_BROWSER_OUTPUT,
  reporter: [['line'], ['json', { outputFile: process.env.TEST_PLAYWRIGHT_JSON }]],
  workers: 1,
  timeout: layer === 'ai-live' ? 120000 : 30000,
  forbidOnly: !!process.env.CI,
  retries: 0,
  use: {
    baseURL: webOrigin,
    headless: true,
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
    ...(layer === 'rtc' ? {
      permissions: ['camera', 'microphone'],
      launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] },
    } : {}),
  },
  webServer: [
    {
      command: `${node} -r ts-node/register/transpile-only src/index.ts`,
      cwd: './server', url: `${apiOrigin}/api/chat/v1/ready`, timeout: 60000, reuseExistingServer: false,
      env: {
        CORS_ORIGINS: webOrigin, NODE_ENV: 'test', PORT: apiPort,
        REDIS_URL: process.env.REDIS_URL_TEST!, REDIS_KEY_PREFIX: process.env.TEST_REDIS_KEY_PREFIX!,
        UPLOAD_ROOT: process.env.UPLOAD_ROOT!, JWT_SECRET: 'browser-regression-secret', METRICS_TOKEN: 'browser-metrics-test', REQUEST_LOGS: 'false',
        ...(layer === 'ai-live' ? {} : { AI_API_KEY: '', DASHSCOPE_API_KEY: '', DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '' }),
        API_RATE_LIMIT_MAX: '10000', AUTH_IP_RATE_LIMIT_MAX: '10000', AUTH_ACCOUNT_RATE_LIMIT_MAX: '10000',
        MESSAGE_USER_RATE: '10000', MESSAGE_USER_BURST: '10000', MESSAGE_PRIVATE_RATE: '10000', MESSAGE_PRIVATE_BURST: '10000',
        MESSAGE_GROUP_RATE: '10000', MESSAGE_GROUP_BURST: '10000', MESSAGE_GLOBAL_RATE: '10000', MESSAGE_GLOBAL_BURST: '10000',
      },
    },
    {
      command: `${node} "${path.resolve('client/node_modules/vite/bin/vite.js')}" --host 127.0.0.1 --port ${webPort} --strictPort`,
      cwd: './client', url: webOrigin, timeout: 60000, reuseExistingServer: false,
      env: { POMELO_DESKTOP_DEV: '1', VITE_API_BASE: `${apiOrigin}/api/chat/v1`, VITE_WS_BASE: `${apiOrigin.replace(/^http/, 'ws')}/api/chat/v1`, VITE_SERVER_URL: apiOrigin },
    },
  ],
});
