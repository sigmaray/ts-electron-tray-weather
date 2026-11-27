import { _electron as electron, ElectronApplication, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Launches the Electron app for testing
 */
export async function launchElectronApp(): Promise<ElectronApplication> {
  // First, make sure the app has been compiled
  const distPath = path.join(__dirname, '../dist/main.js');
  if (!fs.existsSync(distPath)) {
    throw new Error('App is not compiled. Run "npm run build" before the tests.');
  }

  // Remove conflicting environment variables
  const env: { [key: string]: string } = {};
  // Copy string values only
  for (const key in process.env) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key] as string;
    }
  }
  delete env.NO_COLOR;
  env.NODE_ENV = 'test';
  env.ELECTRON_DISABLE_SANDBOX = '1';

  const electronApp = await electron.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', distPath],
    env: env,
    timeout: 30000,
  });

  return electronApp;
}

/**
 * Waits for a window with the specified title to open
 */
export async function waitForWindow(
  electronApp: ElectronApplication,
  title: string,
  timeout: number = 10000
): Promise<Page | null> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    const windows = electronApp.windows();
    for (const window of windows) {
      const windowTitle = await window.title();
      if (windowTitle.includes(title)) {
        return window;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  return null;
}

/**
 * Gets all open Electron windows
 */
export async function getAllWindows(electronApp: ElectronApplication): Promise<Page[]> {
  return electronApp.windows();
}

/**
 * Creates a temporary settings file for tests
 */
export function createTestSettings(settings: any): string {
  const testSettingsPath = path.join(__dirname, '../settings.test.json');
  fs.writeFileSync(testSettingsPath, JSON.stringify(settings, null, 2), 'utf8');
  return testSettingsPath;
}

/**
 * Removes the temporary settings file
 */
export function removeTestSettings(): void {
  const testSettingsPath = path.join(__dirname, '../settings.test.json');
  if (fs.existsSync(testSettingsPath)) {
    fs.unlinkSync(testSettingsPath);
  }
}

/**
 * Loads settings from a file
 */
export function loadTestSettings(): any {
  const testSettingsPath = path.join(__dirname, '../settings.test.json');
  if (fs.existsSync(testSettingsPath)) {
    const content = fs.readFileSync(testSettingsPath, 'utf8');
    return JSON.parse(content);
  }
  return null;
}

