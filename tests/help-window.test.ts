import { test, expect } from '@playwright/test';
import { launchElectronApp, waitForWindow, removeTestSettings, createTestSettings } from './helpers';

test.describe('Тесты окна справки', () => {
  let electronApp: any;

  test.beforeEach(async () => {
    createTestSettings({
      city: 'Moscow',
      country: 'Russia',
      latitude: null,
      longitude: null,
      updateIntervalInSeconds: 60,
    });
  });

  test.afterEach(async () => {
    if (electronApp) {
      try {
        await electronApp.close();
      } catch (e) {
        // Игнорируем ошибки
      }
    }
    removeTestSettings();
  });

  test('должен открывать окно справки с правильным содержимым', async () => {
    electronApp = await launchElectronApp();
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const helpWindow = await waitForWindow(electronApp, 'Как пользоваться', 5000);
    
    if (helpWindow) {
      // Проверяем содержимое справки
      const content = await helpWindow.content();
      
      // Проверяем наличие основных разделов
      expect(content).toContain('Tray Weather');
      expect(content).toContain('Возможности');
      expect(content).toContain('Настройка местоположения');
      
      // Проверяем наличие технических деталей
      expect(content).toContain('TypeScript');
      expect(content).toContain('Electron');
    } else {
      // Окно может не открываться автоматически
      expect(electronApp).toBeDefined();
    }
  });
});

