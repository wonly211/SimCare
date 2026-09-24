import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 120000,
  use: { baseURL: 'http://localhost:8877', browserName: 'chromium', trace: 'retain-on-failure' },
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: 'http://localhost:8877/api/v1/auth/status',
    reuseExistingServer: false,
    timeout: 120000,
  },
});
