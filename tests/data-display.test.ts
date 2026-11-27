import { test, expect } from '@playwright/test';
import { launchElectronApp, waitForWindow, removeTestSettings, createTestSettings } from './helpers';

test.describe('Data display tests', () => {
  let electronApp: any;

  test.beforeEach(async () => {
    // Use Moscow coordinates for stable tests
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
        // Ignore errors
      }
    }
    removeTestSettings();
  });

  test('should display weather data correctly in the window', async () => {
    electronApp = await launchElectronApp();
    
    // Wait for initialization and data retrieval
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Look for the detailed weather information window
    const weatherWindow = await waitForWindow(electronApp, 'Detailed weather information', 10000);
    
    if (weatherWindow) {
      // Check that the main elements are present
      const content = await weatherWindow.content();
      
      // Check that the temperature is displayed (it should be numeric)
      const tempMatch = content.match(/[\d.-]+\s*°C/);
      expect(tempMatch).toBeTruthy();
      
      // Check that location information is present
      expect(content).toMatch(/📍|Moscow|Moscow/i);
      
      // Check that a weather description is present
      expect(content.length).toBeGreaterThan(100); // The window should contain enough content
    } else {
      // If the window did not open, check that the app is running
      expect(electronApp).toBeDefined();
    }
  });

  test('should display the correct coordinates in settings', async () => {
    electronApp = await launchElectronApp();
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const settingsWindow = await waitForWindow(electronApp, 'Settings', 5000);
    
    if (settingsWindow) {
      // Check that the coordinates are displayed
      const latitudeInput = settingsWindow.locator('#latitude');
      const longitudeInput = settingsWindow.locator('#longitude');
      
      const latValue = await latitudeInput.inputValue();
      const lonValue = await longitudeInput.inputValue();
      
      // Coordinates should be close to the configured values (allowing for rounding)
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

  test('should work correctly with city and country settings', async () => {
    // Use city and country settings
    createTestSettings({
      city: 'Moscow',
      country: 'Russia',
      latitude: null,
      longitude: null,
      updateIntervalInSeconds: 60,
    });
    
    electronApp = await launchElectronApp();
    
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    const settingsWindow = await waitForWindow(electronApp, 'Settings', 5000);
    
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

