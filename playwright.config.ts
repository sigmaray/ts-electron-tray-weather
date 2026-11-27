import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for testing the Electron app
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false, // Electron tests are best run sequentially
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // One worker for Electron tests
  timeout: 60000, // Increase the timeout for Electron tests
  reporter: 'html',
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'electron',
      use: { 
        ...devices['Desktop Chrome'],
      },
    },
  ],
});

