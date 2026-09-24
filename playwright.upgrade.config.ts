import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/upgrade',
  fullyParallel: false,
  workers: 1,
  timeout: 120000,
  use: { baseURL: 'http://localhost:8899', browserName: 'chromium', trace: 'off' },
  webServer: {
    command: 'node scripts/upgrade-server.mjs',
    url: 'http://127.0.0.1:8900',
    reuseExistingServer: false,
    timeout: 180000,
  },
});
