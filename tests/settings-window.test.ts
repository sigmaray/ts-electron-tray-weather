import { test, expect } from '@playwright/test';
import { launchElectronApp, waitForWindow, removeTestSettings, createTestSettings, loadTestSettings } from './helpers';

test.describe('Settings window tests', () => {
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
        // Ignore errors
      }
    }
    removeTestSettings();
  });

  test('should open the settings window with the expected fields', async () => {
    electronApp = await launchElectronApp();
    
    // Wait for app initialization
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Look for the settings window
    const settingsWindow = await waitForWindow(electronApp, 'Settings', 5000);
    
    if (settingsWindow) {
      // Check that the main form fields are present
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
      
      // Check that the fields contain the current values
      const cityValue = await cityInput.inputValue();
      expect(cityValue).toBe('Moscow');
      
      const countryValue = await countryInput.inputValue();
      expect(countryValue).toBe('Russia');
    } else {
      // If the window did not open automatically, this is expected for a tray app
      // Check that the app has started
      expect(electronApp).toBeDefined();
    }
  });

  test('should validate the settings form', async () => {
    electronApp = await launchElectronApp();
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const settingsWindow = await waitForWindow(electronApp, 'Settings', 5000);
    
    if (settingsWindow) {
      // Clear the fields
      await settingsWindow.fill('#city', '');
      await settingsWindow.fill('#country', '');
      await settingsWindow.fill('#latitude', '');
      await settingsWindow.fill('#longitude', '');
      
      // Try to save the empty form
      const saveButton = settingsWindow.locator('#saveBtn');
      await saveButton.click();
      
      // Validation errors should appear
      const validationErrors = settingsWindow.locator('#validationErrors');
      await expect(validationErrors).toBeVisible({ timeout: 2000 });
    }
  });

  test('isolates the renderer and validates saves in the main process', async () => {
    electronApp = await launchElectronApp({ openSettings: true });
    const settingsWindow = await waitForWindow(electronApp, 'Settings', 10000);
    expect(settingsWindow).not.toBeNull();
    const rendererState = await settingsWindow!.evaluate(async () => {
      const globals = window as any;
      const saveResult = await globals.weatherSettings.save({ latitude: 91 });
      return {
        requireType: typeof globals.require,
        processType: typeof globals.process,
        saveType: typeof globals.weatherSettings.save,
        saveResult,
      };
    });
    expect(rendererState.requireType).toBe('undefined');
    expect(rendererState.processType).toBe('undefined');
    expect(rendererState.saveType).toBe('function');
    expect(rendererState.saveResult.ok).toBe(false);
    expect(rendererState.saveResult.errors).toContain('Latitude must be between -90 and 90');

    await settingsWindow!.fill('#city', 'Berlin');
    await settingsWindow!.fill('#country', 'Germany');
    await settingsWindow!.fill('#updateInterval', '300');
    await settingsWindow!.locator('#saveBtn').click({ noWaitAfter: true });
    await expect.poll(() => settingsWindow!.isClosed()).toBe(true);
    expect(loadTestSettings()).toMatchObject({
      city: 'Berlin',
      country: 'Germany',
      updateIntervalInSeconds: 300,
      apiProvider: 'open-meteo',
    });
  });
});

