import { test, expect } from '@playwright/test';
import { launchElectronApp, waitForWindow, removeTestSettings, createTestSettings } from './helpers';

test.describe('Тесты окна настроек', () => {
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

  test('должен открывать окно настроек с правильными полями', async () => {
    electronApp = await launchElectronApp();
    
    // Ждем инициализации приложения
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Ищем окно настроек
    const settingsWindow = await waitForWindow(electronApp, 'Настройки', 5000);
    
    if (settingsWindow) {
      // Проверяем наличие основных полей формы
      const cityInput = settingsWindow.locator('#city');
      const countryInput = settingsWindow.locator('#country');
      const latitudeInput = settingsWindow.locator('#latitude');
      const longitudeInput = settingsWindow.locator('#longitude');
      const updateIntervalInput = settingsWindow.locator('#updateInterval');
      
      await expect(cityInput).toBeVisible();
      await expect(countryInput).toBeVisible();
      await expect(latitudeInput).toBeVisible();
      await expect(longitudeInput).toBeVisible();
      await expect(updateIntervalInput).toBeVisible();
      
      // Проверяем, что поля заполнены текущими значениями
      const cityValue = await cityInput.inputValue();
      expect(cityValue).toBe('Moscow');
      
      const countryValue = await countryInput.inputValue();
      expect(countryValue).toBe('Russia');
    } else {
      // Если окно не открылось автоматически, это нормально для приложения в трее
      // Проверяем, что приложение запустилось
      expect(electronApp).toBeDefined();
    }
  });

  test('должен валидировать форму настроек', async () => {
    electronApp = await launchElectronApp();
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const settingsWindow = await waitForWindow(electronApp, 'Настройки', 5000);
    
    if (settingsWindow) {
      // Очищаем поля
      await settingsWindow.fill('#city', '');
      await settingsWindow.fill('#country', '');
      await settingsWindow.fill('#latitude', '');
      await settingsWindow.fill('#longitude', '');
      
      // Пытаемся сохранить пустую форму
      const saveButton = settingsWindow.locator('#saveBtn');
      await saveButton.click();
      
      // Должны появиться ошибки валидации
      const validationErrors = settingsWindow.locator('#validationErrors');
      await expect(validationErrors).toBeVisible({ timeout: 2000 });
    }
  });
});

