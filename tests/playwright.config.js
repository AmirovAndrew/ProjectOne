import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PORT || 8099);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Целевой браузер — Chromium в Tesla (примерно Chrome 100+).
    channel: undefined,
  },

  projects: [
    {
      // Экран автомобиля: альбомная ориентация, ширина ~1200 px.
      name: 'tesla',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1200, height: 800 } },
    },
    {
      // Телефон для отладки — проверяем только раскладку и читаемость.
      name: 'phone',
      testMatch: /layout\.spec\.js/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 412, height: 915 }, isMobile: false },
    },
  ],

  webServer: {
    command: `node server.js ${PORT}`,
    url: `${BASE_URL}/index.html`,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    timeout: 30000,
  },
});
