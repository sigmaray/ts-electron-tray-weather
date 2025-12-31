import { _electron as electron, ElectronApplication, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Запускает Electron приложение для тестирования
 */
export async function launchElectronApp(): Promise<ElectronApplication> {
  // Сначала убеждаемся, что приложение скомпилировано
  const distPath = path.join(__dirname, '../dist/main.js');
  if (!fs.existsSync(distPath)) {
    throw new Error('Приложение не скомпилировано. Запустите "npm run build" перед тестами.');
  }

  // Убираем конфликтующие переменные окружения
  const env: { [key: string]: string } = {};
  // Копируем только строковые значения
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
 * Ожидает открытия окна с заданным заголовком
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
 * Получает все открытые окна Electron
 */
export async function getAllWindows(electronApp: ElectronApplication): Promise<Page[]> {
  return electronApp.windows();
}

/**
 * Создает временный файл настроек для тестов
 */
export function createTestSettings(settings: any): string {
  const testSettingsPath = path.join(__dirname, '../settings.test.json');
  fs.writeFileSync(testSettingsPath, JSON.stringify(settings, null, 2), 'utf8');
  return testSettingsPath;
}

/**
 * Удаляет временный файл настроек
 */
export function removeTestSettings(): void {
  const testSettingsPath = path.join(__dirname, '../settings.test.json');
  if (fs.existsSync(testSettingsPath)) {
    fs.unlinkSync(testSettingsPath);
  }
}

/**
 * Загружает настройки из файла
 */
export function loadTestSettings(): any {
  const testSettingsPath = path.join(__dirname, '../settings.test.json');
  if (fs.existsSync(testSettingsPath)) {
    const content = fs.readFileSync(testSettingsPath, 'utf8');
    return JSON.parse(content);
  }
  return null;
}

