import { defineConfig, devices } from '@playwright/test';

/**
 * Конфигурация Playwright для тестирования Electron приложения
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false, // Electron тесты лучше запускать последовательно
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // Один воркер для Electron тестов
  timeout: 60000, // Увеличиваем таймаут для Electron тестов
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

