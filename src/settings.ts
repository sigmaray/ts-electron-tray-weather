import * as fs from "node:fs";
import * as path from "node:path";

export interface Settings {
  city?: string;
  country?: string;
  latitude?: number | null;
  longitude?: number | null;
  updateIntervalInSeconds?: number;
  apiProvider?: 'open-meteo' | 'openweathermap';
  apiKey?: string;
}

export interface SettingsStorePaths {
  appPath: string;
  resourcesPath: string;
  userDataPath: string;
  overridePath?: string;
}

export function defaultSettings(): Settings {
  return {
    city: "New York City",
    country: "United States",
    latitude: null,
    longitude: null,
    updateIntervalInSeconds: 60,
    apiProvider: 'open-meteo',
  };
}

export function validateSettings(newSettings: Partial<Settings>, currentSettings: Settings): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!newSettings || typeof newSettings !== 'object' || Array.isArray(newSettings)) {
    return { valid: false, errors: ['Settings must be an object'] };
  }
  const allowedKeys = new Set(['city', 'country', 'latitude', 'longitude', 'updateIntervalInSeconds', 'apiProvider', 'apiKey']);
  if (Object.keys(newSettings).some(key => !allowedKeys.has(key))) errors.push('Settings contain an unknown field');

  if (newSettings.updateIntervalInSeconds != null) {
    if (typeof newSettings.updateIntervalInSeconds !== 'number' || !Number.isFinite(newSettings.updateIntervalInSeconds)) {
      errors.push("Update interval must be a number");
    } else if (newSettings.updateIntervalInSeconds < 1) {
      errors.push("Update interval must be at least 1 second");
    }
  }
  if (newSettings.latitude != null) {
    if (typeof newSettings.latitude !== 'number' || !Number.isFinite(newSettings.latitude)) errors.push("Latitude must be a number");
    else if (newSettings.latitude < -90 || newSettings.latitude > 90) errors.push("Latitude must be between -90 and 90");
  }
  if (newSettings.longitude != null) {
    if (typeof newSettings.longitude !== 'number' || !Number.isFinite(newSettings.longitude)) errors.push("Longitude must be a number");
    else if (newSettings.longitude < -180 || newSettings.longitude > 180) errors.push("Longitude must be between -180 and 180");
  }
  if (newSettings.city !== undefined && newSettings.city !== null && (typeof newSettings.city !== 'string' || newSettings.city.trim() === '')) {
    errors.push("City cannot be an empty string (use null to clear it)");
  }
  if (newSettings.country !== undefined && newSettings.country !== null && (typeof newSettings.country !== 'string' || newSettings.country.trim() === '')) {
    errors.push("Country cannot be an empty string (use null to clear it)");
  }
  if (newSettings.apiProvider !== undefined && newSettings.apiProvider !== 'open-meteo' && newSettings.apiProvider !== 'openweathermap') {
    errors.push("API provider must be 'open-meteo' or 'openweathermap'");
  }
  if (newSettings.apiKey !== undefined && newSettings.apiKey !== null && typeof newSettings.apiKey !== 'string') {
    errors.push('API key must be a string');
  }

  const merged = { ...currentSettings, ...newSettings };
  if (merged.apiProvider === 'openweathermap' && (!merged.apiKey || !merged.apiKey.trim())) {
    errors.push("An API key is required when using the OpenWeatherMap API");
  }
  const hasAnyCoordinate = merged.latitude != null || merged.longitude != null;
  const hasBothCoordinates = merged.latitude != null && merged.longitude != null;
  const hasAnyCityCountry = Boolean(merged.city?.trim() || merged.country?.trim());
  const hasBothCityCountry = Boolean(merged.city?.trim() && merged.country?.trim());
  if (hasAnyCoordinate && hasAnyCityCountry) errors.push("You cannot specify both a city/country and coordinates. Choose one option.");
  if (!hasBothCoordinates && !hasBothCityCountry) errors.push("Specify either both coordinates (latitude and longitude) or a city and country");
  return { valid: errors.length === 0, errors };
}

/** Settings storage with portable-mode, legacy migration, and a userData fallback. */
export function createSettingsStore(paths: SettingsStorePaths) {
  const userDataFile = path.join(paths.userDataPath, 'settings.json');
  let fallbackPath: string | null = null;

  const resolvePath = (): string => {
    if (paths.overridePath) return paths.overridePath;
    if (fallbackPath) return fallbackPath;
    const marker = [path.join(paths.resourcesPath, 'portable-mode'), path.join(paths.appPath, 'portable-mode')]
      .find(candidate => fs.existsSync(candidate));
    let target = userDataFile;
    if (marker) {
      const directory = path.dirname(marker);
      try {
        fs.accessSync(directory, fs.constants.W_OK);
        target = path.join(directory, 'settings.json');
        if (!fs.existsSync(target) && fs.existsSync(userDataFile)) fs.copyFileSync(userDataFile, target);
      } catch {
        target = userDataFile;
      }
    }
    if (!fs.existsSync(target)) {
      const legacyPaths = [path.join(paths.appPath, 'settings.json'), path.join(paths.appPath, 'dist', 'settings.json')];
      for (const legacy of legacyPaths) {
        if (legacy === target || !fs.existsSync(legacy)) continue;
        try {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(legacy, target);
          console.info(`[settings] Migrated ${legacy} to ${target}`);
          break;
        } catch (error) {
          console.warn(`[settings] Could not migrate ${legacy}`, error);
        }
      }
    }
    return target;
  };

  return {
    getPath: resolvePath,
    load(): Settings {
      const target = resolvePath();
      try {
        if (!fs.existsSync(target)) {
          const defaults = defaultSettings();
          this.save(defaults);
          return defaults;
        }
        const value: unknown = JSON.parse(fs.readFileSync(target, 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Settings must be a JSON object');
        const loaded = value as Record<string, unknown>;
        const latitude = loaded.latitude;
        const longitude = loaded.longitude;
        return {
          city: typeof loaded.city === 'string' ? loaded.city : undefined,
          country: typeof loaded.country === 'string' ? loaded.country : undefined,
          latitude: typeof latitude === 'number' && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 ? latitude : null,
          longitude: typeof longitude === 'number' && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180 ? longitude : null,
          updateIntervalInSeconds: typeof loaded.updateIntervalInSeconds === 'number'
            && Number.isFinite(loaded.updateIntervalInSeconds) && loaded.updateIntervalInSeconds >= 1
            ? loaded.updateIntervalInSeconds : 60,
          apiProvider: loaded.apiProvider === 'openweathermap' ? 'openweathermap' : 'open-meteo',
          ...(typeof loaded.apiKey === 'string' ? { apiKey: loaded.apiKey } : {}),
        };
      } catch (error) {
        console.error(`[settings] Could not load ${target}`, error);
        return defaultSettings();
      }
    },
    save(settings: Settings): boolean {
      let target = resolvePath();
      const write = (file: string) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8');
      };
      try {
        write(target);
        return true;
      } catch (error) {
        console.error(`[settings] Could not save ${target}`, error);
        if (!paths.overridePath && target !== userDataFile) {
          try {
            write(userDataFile);
            fallbackPath = userDataFile;
            console.warn(`[settings] Saved settings to userData fallback ${userDataFile}`);
            return true;
          } catch (fallbackError) {
            console.error(`[settings] Could not save ${userDataFile}`, fallbackError);
          }
        }
        return false;
      }
    },
  };
}
