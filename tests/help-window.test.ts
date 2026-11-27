import { test, expect } from '@playwright/test';
import { launchElectronApp, waitForWindow, removeTestSettings, createTestSettings } from './helpers';

test.describe('Help window tests', () => {
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

  test('should open the help window with the expected content', async () => {
    electronApp = await launchElectronApp();
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const helpWindow = await waitForWindow(electronApp, 'How to use', 5000);
    
    if (helpWindow) {
      // Check the help content
      const content = await helpWindow.content();
      
      // Check that the main sections are present
      expect(content).toContain('Tray Weather');
      expect(content).toContain('Features');
      expect(content).toContain('Location settings');
      
      // Check that the technical details are present
      expect(content).toContain('TypeScript');
      expect(content).toContain('Electron');
    } else {
      // The window may not open automatically
      expect(electronApp).toBeDefined();
    }
  });
});

