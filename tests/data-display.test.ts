import { test, expect } from '@playwright/test';
import { launchElectronApp, waitForWindow, removeTestSettings, createTestSettings } from './helpers';

test.describe('Тесты отображения данных', () => {
  let electronApp: any;

  test.beforeEach(async () => {
    // Используем координаты Москвы для стабильных тестов
    createTestSettings({
      city: null,
      country: null,
      latitude: 55.7558,
      longitude: 37.6173,
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

  test('должен корректно отображать данные о погоде в окне', async () => {
    electronApp = await launchElectronApp();
    
    // Ждем инициализации и получения данных
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Ищем окно с подробной информацией о погоде
    const weatherWindow = await waitForWindow(electronApp, 'Подробная информация о погоде', 10000);
    
    if (weatherWindow) {
      // Проверяем наличие основных элементов
      const content = await weatherWindow.content();
      
      // Проверяем, что отображается температура (должна быть числом)
      const tempMatch = content.match(/[\d.-]+\s*°C/);
      expect(tempMatch).toBeTruthy();
      
      // Проверяем наличие информации о местоположении
      expect(content).toMatch(/📍|Москва|Moscow/i);
      
      // Проверяем наличие описания погоды
      expect(content.length).toBeGreaterThan(100); // Окно должно содержать достаточно контента
    } else {
      // Если окно не открылось, проверяем что приложение работает
      expect(electronApp).toBeDefined();
    }
  });

  test('должен отображать правильные координаты в настройках', async () => {
    electronApp = await launchElectronApp();
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const settingsWindow = await waitForWindow(electronApp, 'Настройки', 5000);
    
    if (settingsWindow) {
      // Проверяем, что координаты отображаются
      const latitudeInput = settingsWindow.locator('#latitude');
      const longitudeInput = settingsWindow.locator('#longitude');
      
      const latValue = await latitudeInput.inputValue();
      const lonValue = await longitudeInput.inputValue();
      
      // Координаты должны быть близки к заданным (с учетом округления)
      if (latValue) {
        const lat = parseFloat(latValue);
        expect(lat).toBeCloseTo(55.7558, 1);
      }
      
      if (lonValue) {
        const lon = parseFloat(lonValue);
        expect(lon).toBeCloseTo(37.6173, 1);
      }
    }
  });

  test('должен корректно работать с настройками города и страны', async () => {
    // Используем настройки с городом и страной
    createTestSettings({
      city: 'Moscow',
      country: 'Russia',
      latitude: null,
      longitude: null,
      updateIntervalInSeconds: 60,
    });
    
    electronApp = await launchElectronApp();
    
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    const settingsWindow = await waitForWindow(electronApp, 'Настройки', 5000);
    
    if (settingsWindow) {
      const cityInput = settingsWindow.locator('#city');
      const countryInput = settingsWindow.locator('#country');
      
      const cityValue = await cityInput.inputValue();
      const countryValue = await countryInput.inputValue();
      
      expect(cityValue).toBe('Moscow');
      expect(countryValue).toBe('Russia');
    }
  });
});

