import { defineConfig } from '@playwright/test';

// E2E テスト用の専用ポート(開発用の 3000 / 5173 と、ぶつからないようにする)
const SERVER_PORT = 3100;
const WEB_PORT = 5273;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      // 専用の DB を作り直して、サーバーを起動する(apps/server/src/e2e.ts)
      command: 'pnpm --filter @raisechat/server e2e',
      env: { PORT: String(SERVER_PORT), ALLOWED_ORIGIN: `http://localhost:${WEB_PORT}` },
      url: `http://localhost:${SERVER_PORT}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @raisechat/web dev',
      env: { WEB_PORT: String(WEB_PORT), API_TARGET: `http://localhost:${SERVER_PORT}` },
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
