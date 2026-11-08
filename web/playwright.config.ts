import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 120000,
  workers: 1,
  use: {
    locale: 'en-US',
    baseURL: 'http://127.0.0.1:5174',
    channel: 'chrome',
    viewport: { width: 1440, height: 1000 },
    actionTimeout: 15000,
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev:mock -- --strictPort --port 5174',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: true,
    timeout: 30000,
  },
});
