import { Settings, validateSettings } from './settings';

export interface SettingsInvokeHandlers {
  handle(channel: string, listener: (event: { sender: unknown }, value: unknown) => Promise<SettingsSaveResult>): void;
  removeHandler(channel: string): void;
}

export type SettingsSaveResult = { ok: true } | { ok: false; errors: string[] };

export function registerSettingsSaveHandler(
  handlers: SettingsInvokeHandlers,
  dependencies: {
    getCurrentSettings(): Settings;
    isTrustedSender(sender: unknown): boolean;
    apply(settings: Settings): Promise<boolean>;
    onSaved(): void;
  },
): void {
  handlers.handle('settings:save', async (event, value) => {
    if (!dependencies.isTrustedSender(event.sender)) return { ok: false, errors: ['Settings window is no longer available'] };
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, errors: ['Settings must be an object'] };
    const validation = validateSettings(value as Partial<Settings>, dependencies.getCurrentSettings());
    if (!validation.valid) return { ok: false, errors: validation.errors };
    if (!await dependencies.apply(value as Settings)) {
      return {
        ok: false,
        errors: ['Could not apply the settings. Check the coordinates or city and country. The app will continue using the previous settings.'],
      };
    }
    dependencies.onSaved();
    return { ok: true };
  });
}
