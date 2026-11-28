import { app, Tray, Menu, nativeImage, NativeImage, dialog, BrowserWindow, shell, ipcMain, Notification, screen } from "electron";
import { createCanvas } from "canvas";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createSettingsStore, Settings } from "./settings";
import { registerSettingsSaveHandler } from "./settings-ipc";

const isMac = os.platform() === "darwin";
const isWindows = os.platform() === "win32";
const isLinux = os.platform() === "linux";

// Constant controlling whether only one app instance is allowed
const ALLOW_ONLY_ONE_INSTANCE = process.env.ALLOW_ONLY_ONE_INSTANCE !== 'false';

const settingsStore = createSettingsStore({
  appPath: app.getAppPath(),
  resourcesPath: process.resourcesPath,
  userDataPath: app.getPath("userData"),
  overridePath: process.env.WEATHER_SETTINGS_PATH,
});

function getSettingsPath(): string {
  return settingsStore.getPath();
}

function loadSettings(): Settings {
  return settingsStore.load();
}

// Load settings
let settings = loadSettings();

// Read location settings from settings.json
// Specify either coordinates (latitude, longitude) or a city and country (city, country)
let CITY: string | undefined = settings.city;
let COUNTRY: string | undefined = settings.country;

// If CITY and COUNTRY are set but LATITUDE and LONGITUDE are not, look up the coordinates through the API
let LATITUDE: number | null = settings.latitude ?? null;
let LONGITUDE: number | null = settings.longitude ?? null;

// Temperature refresh interval in seconds (default: 60)
let UPDATE_INTERVAL_SECONDS: number = settings.updateIntervalInSeconds ?? 60;

// API provider (default: open-meteo)
let API_PROVIDER: 'open-meteo' | 'openweathermap' = settings.apiProvider ?? 'open-meteo';

// API key (required for openweathermap)
let API_KEY: string | undefined = settings.apiKey;

// Weather request URL (generated in initializeLocation)
let WEATHER_URL = "";

let tray: Tray | null = null;
let weatherTray: Tray | null = null; // Second icon for weather conditions
let updateInterval: NodeJS.Timeout | null = null;
let lastUpdateTime: Date | null = null;
let cityName: string = "";
let countryName: string = "";

// Array storing the 100 most recent API errors
interface ApiError {
  timestamp: Date;
  api: string; // API name (weather, geocoding, etc.)
  error: string; // Error message
  url?: string; // Request URL (optional)
  statusCode?: number; // HTTP status code (404, 403, 500, etc.)
  errorCode?: string; // Node.js error code (ENOTFOUND, ECONNREFUSED, etc.)
  details?: string; // Additional details
}

const apiErrors: ApiError[] = [];
const MAX_ERRORS = 100;

// Array storing the 100 most recent API requests
interface ApiRequest {
  timestamp: Date;
  api: string; // API name (weather, geocoding, etc.)
  url: string; // request URL
  method: string; // HTTP method (GET, POST, etc.)
  requestHeaders?: Record<string, string>; // Request headers
  responseStatus?: number; // HTTP response status code
  responseHeaders?: Record<string, string>; // Response headers
  responseBody?: string; // Response body (JSON string)
  duration?: number; // Request duration in ms
}

const apiRequests: ApiRequest[] = [];
const MAX_REQUESTS = 100;

// References to open windows (to prevent duplicates)
let settingsWindow: BrowserWindow | null = null;
let weatherWindow: BrowserWindow | null = null;
let isWeatherDetailsOpening = false;
let requestWindow: BrowserWindow | null = null;
let errorWindow: BrowserWindow | null = null;
let helpWindow: BrowserWindow | null = null;

/**
 * Extract detailed information from an error
 */
function extractErrorDetails(err: unknown): {
  message: string;
  errorCode?: string;
  statusCode?: number;
  details?: string;
} {
  if (err instanceof Error) {
    const message = err.message;
    let errorCode: string | undefined;
    let statusCode: number | undefined;
    let details: string | undefined;

    // Check for a Node.js error code (ENOTFOUND, ECONNREFUSED, etc.)
    if ((err as any).code) {
      errorCode = (err as any).code;
    }

    // Check for an HTTP status code
    const httpStatusMatch = message.match(/HTTP error (\d+)/i) || message.match(/status (\d+)/i);
    if (httpStatusMatch) {
      statusCode = parseInt(httpStatusMatch[1], 10);
    }

    // Extract additional details from the stack trace or other properties
    if (err.stack) {
      const stackLines = err.stack.split('\n');
      if (stackLines.length > 1) {
        details = stackLines.slice(1, 3).join('\n').trim(); // First two stack trace lines after the message
      }
    }

    // If a cause property exists, include it in the details
    if ((err as any).cause) {
      const cause = (err as any).cause;
      if (details) {
        details += `\nCause: ${cause instanceof Error ? cause.message : String(cause)}`;
      } else {
        details = `Cause: ${cause instanceof Error ? cause.message : String(cause)}`;
      }
    }

    return { message, errorCode, statusCode, details };
  }

  return { message: String(err) };
}

/**
 * Add an error with details to the recent errors list
 */
function addApiError(api: string, error: string | Error, url?: string, additionalInfo?: { statusCode?: number; errorCode?: string }): void {
  const errorDetails = extractErrorDetails(error);
  
  const apiError: ApiError = {
    timestamp: new Date(),
    api,
    error: errorDetails.message,
    url,
    statusCode: additionalInfo?.statusCode || errorDetails.statusCode,
    errorCode: additionalInfo?.errorCode || errorDetails.errorCode,
    details: errorDetails.details,
  };
  
  apiErrors.push(apiError);
  
  // Limit the number of errors to MAX_ERRORS
  if (apiErrors.length > MAX_ERRORS) {
    apiErrors.shift(); // Remove the oldest error
  }
  
  const errorInfo = [
    errorDetails.message,
    errorDetails.errorCode && `Code: ${errorDetails.errorCode}`,
    errorDetails.statusCode && `HTTP: ${errorDetails.statusCode}`,
  ].filter(Boolean).join(', ');
  
  console.error(`[${api}] Error added to history:`, errorInfo);
}

/**
 * Add a request to the recent requests history
 */
function addApiRequest(api: string, url: string, method: string, requestHeaders?: Record<string, string>, responseStatus?: number, responseHeaders?: Record<string, string>, responseBody?: string, duration?: number): void {
  const apiRequest: ApiRequest = {
    timestamp: new Date(),
    api,
    url,
    method,
    requestHeaders,
    responseStatus,
    responseHeaders,
    responseBody,
    duration,
  };
  
  apiRequests.push(apiRequest);
  
  // Limit the number of requests to MAX_REQUESTS
  if (apiRequests.length > MAX_REQUESTS) {
    apiRequests.shift(); // Remove the oldest request
  }
  
  console.log(`[${api}] Request added to history: ${method} ${url} (${responseStatus || 'N/A'})`);
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  const map: { [key: string]: string } = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

/**
 * Check whether a string is a URL
 */
function isUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Save settings to settings.json
 */
function saveSettings(newSettings: Settings): boolean {
  return settingsStore.save(newSettings);
}

/**
 * Apply new settings and reinitialize the app
 */
async function applySettings(newSettings: Settings): Promise<boolean> {
  // Save the current settings in case rollback is needed
  const previousSettings = { ...settings };
  const previousCity = CITY;
  const previousCountry = COUNTRY;
  const previousLatitude = LATITUDE;
  const previousLongitude = LONGITUDE;
  const previousUpdateInterval = UPDATE_INTERVAL_SECONDS;
  const previousWeatherUrl = WEATHER_URL;
  const previousCityName = cityName;
  const previousCountryName = countryName;
  const previousApiProvider = API_PROVIDER;
  const previousApiKey = API_KEY;

  // Merge with the current settings (in case of a partial update)
  const mergedSettings: Settings = {
    ...settings,
    ...newSettings,
  };

  // Update the global variables
  // Explicitly set null/undefined to clear old values
  CITY = mergedSettings.city ?? undefined;
  COUNTRY = mergedSettings.country ?? undefined;
  LATITUDE = mergedSettings.latitude ?? null;
  LONGITUDE = mergedSettings.longitude ?? null;
  UPDATE_INTERVAL_SECONDS = mergedSettings.updateIntervalInSeconds ?? 60;
  API_PROVIDER = mergedSettings.apiProvider ?? 'open-meteo';
  API_KEY = mergedSettings.apiKey;
  settings = mergedSettings;
  
  // Clear WEATHER_URL when settings change so it is recreated in initializeLocation
  WEATHER_URL = "";
  
  // If switching from a city/country to coordinates, clear the old names
  // so they can be refreshed from the new coordinates
  if (previousCity && previousCountry && (CITY === undefined || COUNTRY === undefined) && 
      LATITUDE !== null && LONGITUDE !== null) {
    cityName = "";
    countryName = "";
  }

  // Save to file
  if (!saveSettings(mergedSettings)) {
    // Roll back changes if saving fails
    CITY = previousCity;
    COUNTRY = previousCountry;
    LATITUDE = previousLatitude;
    LONGITUDE = previousLongitude;
    UPDATE_INTERVAL_SECONDS = previousUpdateInterval;
    WEATHER_URL = previousWeatherUrl;
    cityName = previousCityName;
    countryName = previousCountryName;
    API_PROVIDER = previousApiProvider;
    API_KEY = previousApiKey;
    settings = previousSettings;
    return false;
  }

  // Reinitialize the location
  const initialized = await initializeLocation();
  if (!initialized) {
    // Roll back changes if initialization fails
    CITY = previousCity;
    COUNTRY = previousCountry;
    LATITUDE = previousLatitude;
    LONGITUDE = previousLongitude;
    UPDATE_INTERVAL_SECONDS = previousUpdateInterval;
    WEATHER_URL = previousWeatherUrl;
    cityName = previousCityName;
    countryName = previousCountryName;
    API_PROVIDER = previousApiProvider;
    API_KEY = previousApiKey;
    settings = previousSettings;
    // Restore the file with the previous settings
    saveSettings(previousSettings);
    // Do not reinitialize the location; keep the current state
    // The app will continue using the previous settings
    console.log("Changes rolled back. The app continues running with the previous settings.");
    return false;
  }

  // Update the refresh interval
  if (updateInterval) {
    clearInterval(updateInterval);
  }
  const updateIntervalMs = UPDATE_INTERVAL_SECONDS * 1000;
  console.log(`Temperature update interval updated: ${UPDATE_INTERVAL_SECONDS} seconds (${updateIntervalMs} ms)`);
  updateInterval = setInterval(() => {
    void updateTrayTemperature();
  }, updateIntervalMs);

  // Refresh the temperature immediately
  void updateTrayTemperature();

  return true;
}

/**
 * Get coordinates to center a window on the primary display
 */
function getWindowPositionOnPrimaryDisplay(width: number, height: number): { x: number; y: number } {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
  const { x: screenX, y: screenY } = primaryDisplay.workArea;
  
  return {
    x: Math.round(screenX + (screenWidth - width) / 2),
    y: Math.round(screenY + (screenHeight - height) / 2),
  };
}

/**
 * Show the settings dialog for editing settings.json
 */
function showSettings(): void {
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Settings</title>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
          font-size: 14px;
          line-height: 1.5;
          color: #333;
          background: #f5f5f5;
          padding: 20px;
        }
        .container {
          max-width: 600px;
          margin: 0 auto;
          background: #fff;
          border-radius: 8px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
          padding: 24px;
        }
        h1 {
          font-size: 20px;
          font-weight: 600;
          color: #1976d2;
          margin-bottom: 20px;
          padding-bottom: 12px;
          border-bottom: 2px solid #e0e0e0;
        }
        .form-group {
          margin-bottom: 20px;
        }
        label {
          display: block;
          font-weight: 500;
          margin-bottom: 6px;
          color: #424242;
        }
        .label-hint {
          font-size: 12px;
          color: #757575;
          font-weight: normal;
          margin-left: 4px;
        }
        input[type="text"],
        input[type="number"] {
          width: 100%;
          padding: 8px 12px;
          border: 1px solid #ddd;
          border-radius: 4px;
          font-size: 14px;
          transition: border-color 0.2s;
        }
        input[type="text"]:focus,
        input[type="number"]:focus {
          outline: none;
          border-color: #1976d2;
          box-shadow: 0 0 0 2px rgba(25, 118, 210, 0.1);
        }
        input.error {
          border-color: #d32f2f;
        }
        .error-message {
          color: #d32f2f;
          font-size: 12px;
          margin-top: 4px;
          display: none;
        }
        .error-message.show {
          display: block;
        }
        .checkbox-group {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        input[type="checkbox"] {
          width: 18px;
          height: 18px;
          cursor: pointer;
        }
        .buttons {
          display: flex;
          gap: 12px;
          justify-content: flex-end;
          margin-top: 24px;
          padding-top: 20px;
          border-top: 1px solid #e0e0e0;
        }
        button {
          padding: 10px 24px;
          border: none;
          border-radius: 4px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: background-color 0.2s;
        }
        button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .btn-cancel {
          background: #f5f5f5;
          color: #424242;
        }
        .btn-cancel:hover:not(:disabled) {
          background: #e0e0e0;
        }
        .btn-save {
          background: #1976d2;
          color: #fff;
        }
        .btn-save:hover:not(:disabled) {
          background: #1565c0;
        }
        .validation-errors {
          background: #ffebee;
          border: 1px solid #d32f2f;
          border-radius: 4px;
          padding: 12px;
          margin-bottom: 20px;
          display: none;
        }
        .validation-errors.show {
          display: block;
        }
        .validation-errors h3 {
          color: #d32f2f;
          font-size: 14px;
          font-weight: 600;
          margin-bottom: 8px;
        }
        .validation-errors ul {
          margin-left: 20px;
          color: #c62828;
        }
        .validation-errors li {
          margin-bottom: 4px;
        }
        .info-box {
          background: #e3f2fd;
          border: 1px solid #1976d2;
          border-radius: 4px;
          padding: 12px;
          margin-bottom: 20px;
          font-size: 13px;
          line-height: 1.6;
        }
        .info-box h3 {
          color: #1976d2;
          font-size: 14px;
          font-weight: 600;
          margin-bottom: 8px;
        }
        .info-box p {
          color: #424242;
          margin-bottom: 6px;
        }
        .info-box p:last-child {
          margin-bottom: 0;
        }
        .info-box code {
          background: rgba(25, 118, 210, 0.1);
          padding: 2px 6px;
          border-radius: 3px;
          font-family: "Courier New", monospace;
          font-size: 12px;
          color: #1565c0;
        }
        .info-box ul {
          margin-left: 20px;
          margin-top: 6px;
          color: #424242;
        }
        .info-box li {
          margin-bottom: 4px;
        }
        .quick-links {
          background: #f5f5f5;
          border: 1px solid #e0e0e0;
          border-radius: 4px;
          padding: 12px;
          margin-bottom: 20px;
        }
        .quick-links h3 {
          font-size: 13px;
          font-weight: 600;
          color: #424242;
          margin-bottom: 8px;
        }
        .quick-links-list {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }
        .quick-link {
          color: #1976d2;
          text-decoration: none;
          padding: 6px 12px;
          border: 1px solid #1976d2;
          border-radius: 4px;
          font-size: 13px;
          transition: all 0.2s;
          cursor: pointer;
          display: inline-block;
        }
        .quick-link:hover {
          background: #1976d2;
          color: #fff;
        }
        .toast {
          position: fixed;
          top: 20px;
          right: 20px;
          background: #4caf50;
          color: #fff;
          padding: 16px 24px;
          border-radius: 4px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
          font-size: 14px;
          font-weight: 500;
          z-index: 10000;
          opacity: 0;
          transform: translateY(-20px);
          transition: opacity 0.3s ease, transform 0.3s ease;
          pointer-events: none;
        }
        .toast.show {
          opacity: 1;
          transform: translateY(0);
        }
        .toast.hide {
          opacity: 0;
          transform: translateY(-20px);
        }
      </style>
    </head>
    <body>
      <div id="toast" class="toast"></div>
      <div class="container">
        <h1>⚙️ Settings</h1>
        
        <div class="info-box">
          <h3>ℹ️ Important information</h3>
          <p><strong>Specify one of the following:</strong></p>
          <ul>
            <li><strong>City and Country</strong> — coordinates will be looked up automatically</li>
            <li><strong>Latitude and Longitude</strong> — coordinates are entered manually</li>
          </ul>
          <p style="margin-top: 12px;">
            <strong>Settings file:</strong> <code>${getSettingsPath()}</code>
          </p>
        </div>
        
        <div id="validationErrors" class="validation-errors">
          <h3>Validation errors:</h3>
          <ul id="validationErrorsList"></ul>
        </div>

        <form id="settingsForm">
          <div class="form-group">
            <label>
              City
              <span class="label-hint">(e.g. "Minsk" or leave blank)</span>
            </label>
            <input type="text" id="city" placeholder="Enter a city name">
            <div class="error-message" id="cityError"></div>
          </div>

          <div class="form-group">
            <label>
              Country
              <span class="label-hint">(e.g. "Belarus" or leave blank)</span>
            </label>
            <input type="text" id="country" placeholder="Enter a country name">
            <div class="error-message" id="countryError"></div>
          </div>

          <div class="quick-links">
            <h3>📍 Quick city selection:</h3>
            <div class="quick-links-list">
              <a href="#" class="quick-link" data-city="Warsaw" data-country="Poland">Warsaw / Poland</a>
              <a href="#" class="quick-link" data-city="Minsk" data-country="Belarus">Minsk / Belarus</a>
              <a href="#" class="quick-link" data-city="Astana" data-country="Kazakhstan">Astana / Kazakhstan</a>
              <a href="#" class="quick-link" data-city="Berlin" data-country="Germany">Berlin / Germany</a>
              <a href="#" class="quick-link" data-city="Paris" data-country="France">Paris / France</a>
              <a href="#" class="quick-link" data-city="New York" data-country="United States">New York / United States</a>
            </div>
          </div>

          <div class="form-group">
            <label>
              Latitude
              <span class="label-hint">(-90 to 90, or leave blank)</span>
            </label>
            <input type="number" id="latitude" step="any" placeholder="For example: 53.9045">
            <div class="error-message" id="latitudeError"></div>
          </div>

          <div class="form-group">
            <label>
              Longitude
              <span class="label-hint">(-180 to 180, or leave blank)</span>
            </label>
            <input type="number" id="longitude" step="any" placeholder="For example: 27.5615">
            <div class="error-message" id="longitudeError"></div>
          </div>

          <div class="form-group">
            <label>
              Update interval (seconds)
              <span class="label-hint">(minimum 1 second)</span>
            </label>
            <input type="number" id="updateInterval" min="1" step="1" placeholder="60">
            <div class="error-message" id="updateIntervalError"></div>
          </div>

          <div class="form-group">
            <label>
              API provider
              <span class="label-hint">(select a weather data source)</span>
            </label>
            <select id="apiProvider" style="width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px;">
              <option value="open-meteo">Open-Meteo (free, no API key required)</option>
              <option value="openweathermap">OpenWeatherMap (API key required)</option>
            </select>
            <div class="error-message" id="apiProviderError"></div>
          </div>

          <div class="form-group" id="apiKeyGroup" style="display: none;">
            <label>
              API key (OpenWeatherMap)
              <span class="label-hint">(required for OpenWeatherMap)</span>
            </label>
            <input type="text" id="apiKey" placeholder="Enter your OpenWeatherMap API key">
            <div class="error-message" id="apiKeyError"></div>
            <p style="margin-top: 8px; font-size: 12px; color: #757575;">
              Get an API key at <a href="https://openweathermap.org/api" target="_blank" style="color: #1976d2;">openweathermap.org/api</a>
            </p>
          </div>

          <div class="buttons">
            <button type="button" class="btn-cancel" id="cancelBtn">Cancel</button>
            <button type="submit" class="btn-save" id="saveBtn">Save</button>
          </div>
        </form>
      </div>

      <script>
        // Load the current settings
        const currentSettings = ${JSON.stringify(settings)};
        
        // Fill the form with the current values
        document.getElementById('city').value = currentSettings.city || '';
        document.getElementById('country').value = currentSettings.country || '';
        document.getElementById('latitude').value = currentSettings.latitude !== null && currentSettings.latitude !== undefined ? currentSettings.latitude : '';
        document.getElementById('longitude').value = currentSettings.longitude !== null && currentSettings.longitude !== undefined ? currentSettings.longitude : '';
        document.getElementById('updateInterval').value = currentSettings.updateIntervalInSeconds || 60;
        document.getElementById('apiProvider').value = currentSettings.apiProvider || 'open-meteo';
        document.getElementById('apiKey').value = currentSettings.apiKey || '';
        
        // Show or hide the API key field based on the selected provider
        const apiProviderSelect = document.getElementById('apiProvider');
        const apiKeyGroup = document.getElementById('apiKeyGroup');
        
        function toggleApiKeyField() {
          if (apiProviderSelect.value === 'openweathermap') {
            apiKeyGroup.style.display = 'block';
          } else {
            apiKeyGroup.style.display = 'none';
          }
        }
        
        toggleApiKeyField();
        apiProviderSelect.addEventListener('change', toggleApiKeyField);

        // On load, if both options are set, clear the coordinates (city/country takes priority)
        const hasCityCountry = (currentSettings.city && currentSettings.city.trim() !== '') &&
                               (currentSettings.country && currentSettings.country.trim() !== '');
        const hasAnyCoordinate = (currentSettings.latitude !== null && currentSettings.latitude !== undefined) ||
                                (currentSettings.longitude !== null && currentSettings.longitude !== undefined);
        
        if (hasCityCountry && hasAnyCoordinate) {
          // Clear the coordinates if city and country are set
          document.getElementById('latitude').value = '';
          document.getElementById('longitude').value = '';
        }

        function clearErrors() {
          document.querySelectorAll('.error-message').forEach(el => el.classList.remove('show'));
          document.querySelectorAll('input').forEach(el => el.classList.remove('error'));
          document.getElementById('validationErrors').classList.remove('show');
        }

        function showFieldError(fieldId, message) {
          const field = document.getElementById(fieldId);
          const errorEl = document.getElementById(fieldId + 'Error');
          field.classList.add('error');
          errorEl.textContent = message;
          errorEl.classList.add('show');
        }

        function showValidationErrors(errors) {
          const container = document.getElementById('validationErrors');
          const list = document.getElementById('validationErrorsList');
          list.innerHTML = errors.map(err => '<li>' + err + '</li>').join('');
          container.classList.add('show');
        }

        document.getElementById('settingsForm').addEventListener('submit', (e) => {
          e.preventDefault();
          clearErrors();

          // Collect the form data
          const cityValue = document.getElementById('city').value.trim();
          const countryValue = document.getElementById('country').value.trim();
          const latitudeValue = document.getElementById('latitude').value.trim();
          const longitudeValue = document.getElementById('longitude').value.trim();
          const updateIntervalValue = document.getElementById('updateInterval').value.trim();
          const apiProviderValue = document.getElementById('apiProvider').value;
          const apiKeyValue = document.getElementById('apiKey').value.trim();

          const newSettings = {
            city: cityValue === '' ? null : cityValue,
            country: countryValue === '' ? null : countryValue,
            latitude: latitudeValue === '' ? null : (isNaN(parseFloat(latitudeValue)) ? null : parseFloat(latitudeValue)),
            longitude: longitudeValue === '' ? null : (isNaN(parseFloat(longitudeValue)) ? null : parseFloat(longitudeValue)),
            updateIntervalInSeconds: updateIntervalValue === '' ? 60 : parseInt(updateIntervalValue, 10),
            apiProvider: apiProviderValue,
            apiKey: apiKeyValue === '' ? undefined : apiKeyValue,
          };

          // Client-side validation (basic)
          const validation = {
            valid: true,
            errors: []
          };

          if (newSettings.updateIntervalInSeconds < 1 || isNaN(newSettings.updateIntervalInSeconds)) {
            validation.valid = false;
            validation.errors.push('Update interval must be at least 1 second');
            showFieldError('updateInterval', 'Interval must be at least 1 second');
          }

          // Validate the API provider and key
          if (newSettings.apiProvider !== 'open-meteo' && newSettings.apiProvider !== 'openweathermap') {
            validation.valid = false;
            validation.errors.push('Invalid API provider');
            showFieldError('apiProvider', 'Choose a valid API provider');
          }

          if (newSettings.apiProvider === 'openweathermap' && (!newSettings.apiKey || newSettings.apiKey.trim() === '')) {
            validation.valid = false;
            validation.errors.push('An API key is required when using OpenWeatherMap');
            showFieldError('apiKey', 'An API key is required for OpenWeatherMap');
          }

          if (newSettings.latitude !== null && (isNaN(newSettings.latitude) || newSettings.latitude < -90 || newSettings.latitude > 90)) {
            validation.valid = false;
            validation.errors.push('Latitude must be a number between -90 and 90');
            showFieldError('latitude', 'Latitude must be between -90 and 90');
          }

          if (newSettings.longitude !== null && (isNaN(newSettings.longitude) || newSettings.longitude < -180 || newSettings.longitude > 180)) {
            validation.valid = false;
            validation.errors.push('Longitude must be a number between -180 and 180');
            showFieldError('longitude', 'Longitude must be between -180 and 180');
          }

          // Check whether at least one coordinate is set
          const hasAnyCoordinate = (newSettings.latitude !== null && newSettings.latitude !== undefined) ||
                                   (newSettings.longitude !== null && newSettings.longitude !== undefined);
          const hasBothCoordinates = newSettings.latitude !== null && newSettings.latitude !== undefined &&
                                     newSettings.longitude !== null && newSettings.longitude !== undefined;
          
          // Check whether either city or country is set
          const hasAnyCityCountry = (newSettings.city && newSettings.city.trim() !== '') ||
                                    (newSettings.country && newSettings.country.trim() !== '');
          const hasBothCityCountry = newSettings.city && newSettings.city.trim() !== '' &&
                                     newSettings.country && newSettings.country.trim() !== '';

          // Check that both options are not set at the same time, even partially
          if (hasAnyCoordinate && hasAnyCityCountry) {
            validation.valid = false;
            validation.errors.push('You cannot specify both a city/country and coordinates. Choose one option.');
          }

          // Check that at least one complete option is set
          if (!hasBothCoordinates && !hasBothCityCountry) {
            validation.valid = false;
            validation.errors.push('Specify either both coordinates (latitude and longitude) or a city and country');
          }

          if (!validation.valid) {
            showValidationErrors(validation.errors);
            return;
          }

          // Send settings to the main process for validation and saving
          window.weatherSettings.save(newSettings).then((result) => {
            if (!result.ok) showValidationErrors(result.errors || ['Could not save settings']);
          }).catch(() => showValidationErrors(['Could not save settings']));
        });

        document.getElementById('cancelBtn').addEventListener('click', () => {
          window.close();
        });

        // Mutual exclusion: clear coordinates when city/country is entered
        const cityInput = document.getElementById('city');
        const countryInput = document.getElementById('country');
        const latitudeInput = document.getElementById('latitude');
        const longitudeInput = document.getElementById('longitude');

        function clearCoordinates() {
          latitudeInput.value = '';
          longitudeInput.value = '';
        }

        function clearCityCountry() {
          cityInput.value = '';
          countryInput.value = '';
        }

        // Clear coordinates when entering a city or country
        cityInput.addEventListener('input', () => {
          if (cityInput.value.trim() !== '') {
            clearCoordinates();
          }
        });

        cityInput.addEventListener('change', () => {
          if (cityInput.value.trim() !== '') {
            clearCoordinates();
          }
        });

        countryInput.addEventListener('input', () => {
          if (countryInput.value.trim() !== '') {
            clearCoordinates();
          }
        });

        countryInput.addEventListener('change', () => {
          if (countryInput.value.trim() !== '') {
            clearCoordinates();
          }
        });

        // Clear city and country when entering coordinates
        latitudeInput.addEventListener('input', () => {
          if (latitudeInput.value.trim() !== '') {
            clearCityCountry();
          }
        });

        latitudeInput.addEventListener('change', () => {
          if (latitudeInput.value.trim() !== '') {
            clearCityCountry();
          }
        });

        longitudeInput.addEventListener('input', () => {
          if (longitudeInput.value.trim() !== '') {
            clearCityCountry();
          }
        });

        longitudeInput.addEventListener('change', () => {
          if (longitudeInput.value.trim() !== '') {
            clearCityCountry();
          }
        });

        // Handle quick city links
        document.querySelectorAll('.quick-link').forEach(link => {
          link.addEventListener('click', (e) => {
            e.preventDefault();
            const city = link.getAttribute('data-city');
            const country = link.getAttribute('data-country');
            if (city && country) {
              document.getElementById('city').value = city;
              document.getElementById('country').value = country;
              // Clear coordinates when a city is selected
              clearCoordinates();
              // Clear errors
              clearErrors();
            }
          });
        });

        // Function to show a toast notification
        function showToast(message, duration = 3000) {
          const toast = document.getElementById('toast');
          toast.textContent = message;
          toast.classList.remove('hide');
          toast.classList.add('show');
          
          setTimeout(() => {
            toast.classList.remove('show');
            toast.classList.add('hide');
            setTimeout(() => {
              window.close();
            }, 300); // Close the window after the fade-out animation
          }, duration);
        }

      </script>
    </body>
    </html>
  `;

  // Check whether the window is already open
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) {
      settingsWindow.restore();
    }
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  // Create the settings window
  const windowSize = { width: 650, height: 700 };
  const windowPosition = getWindowPositionOnPrimaryDisplay(windowSize.width, windowSize.height);
  settingsWindow = new BrowserWindow({
    width: windowSize.width,
    height: windowSize.height,
    x: windowPosition.x,
    y: windowPosition.y,
    title: "Settings — Tray Weather",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    resizable: true,
    modal: false,
  });

  // Load the HTML content
  settingsWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  settingsWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('data:text/html')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  registerSettingsSaveHandler(ipcMain, {
    getCurrentSettings: () => settings,
    isTrustedSender: sender => !settingsWindow?.isDestroyed() && sender === settingsWindow?.webContents,
    apply: applySettings,
    onSaved: () => {
      settingsWindow?.close();
      setTimeout(() => {
        if (Notification.isSupported()) {
          new Notification({ title: 'Settings saved', body: 'Settings were saved and applied successfully.', silent: false }).show();
        }
      }, 100);
    },
  });

  // Window close handler: clear the reference and remove the IPC handler
  settingsWindow.on('closed', () => {
    ipcMain.removeHandler('settings:save');
    settingsWindow = null;
  });
}

/**
 * Show the app help window
 */
function showHelp(): void {
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>How to use</title>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
          font-size: 14px;
          line-height: 1.6;
          color: #333;
          background: #fff;
          padding: 20px;
        }
        .header {
          margin-bottom: 20px;
          padding-bottom: 16px;
          border-bottom: 2px solid #1976d2;
        }
        .header h1 {
          font-size: 24px;
          font-weight: 600;
          color: #1976d2;
          margin-bottom: 8px;
        }
        .content {
          max-height: calc(100vh - 120px);
          overflow-y: auto;
          overflow-x: hidden;
        }
        .section {
          margin-bottom: 24px;
        }
        .section h2 {
          font-size: 18px;
          font-weight: 600;
          color: #1976d2;
          margin-bottom: 12px;
          padding-bottom: 8px;
          border-bottom: 1px solid #e0e0e0;
        }
        .section h3 {
          font-size: 16px;
          font-weight: 600;
          color: #424242;
          margin-top: 16px;
          margin-bottom: 8px;
        }
        .section p {
          margin-bottom: 12px;
          color: #555;
        }
        .section ul, .section ol {
          margin-left: 24px;
          margin-bottom: 12px;
          color: #555;
        }
        .section li {
          margin-bottom: 8px;
        }
        .section code {
          background: #f5f5f5;
          padding: 2px 6px;
          border-radius: 3px;
          font-family: "Courier New", monospace;
          font-size: 13px;
          color: #d32f2f;
        }
        .section pre {
          background: #f5f5f5;
          padding: 12px;
          border-radius: 4px;
          overflow-x: auto;
          margin-bottom: 12px;
          font-family: "Courier New", monospace;
          font-size: 12px;
        }
        .feature-list {
          list-style: none;
          margin-left: 0;
        }
        .feature-list li {
          margin-bottom: 12px;
          padding-left: 24px;
          position: relative;
        }
        .feature-list li::before {
          content: "✓";
          position: absolute;
          left: 0;
          color: #4caf50;
          font-weight: bold;
        }
        .url-link {
          color: #1976d2;
          text-decoration: none;
        }
        .url-link:hover {
          text-decoration: underline;
        }
        /* Scrollbar styles */
        .content::-webkit-scrollbar {
          width: 10px;
        }
        .content::-webkit-scrollbar-track {
          background: #f1f1f1;
          border-radius: 5px;
        }
        .content::-webkit-scrollbar-thumb {
          background: #888;
          border-radius: 5px;
        }
        .content::-webkit-scrollbar-thumb:hover {
          background: #555;
        }
        .highlight {
          background: #fff9c4;
          padding: 2px 4px;
          border-radius: 2px;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>🌡️ Tray Weather — Help</h1>
        <p>An app that displays the current temperature in the system tray</p>
      </div>
      <div class="content">
        <div class="section">
          <h2>📋 Features</h2>
          <ul class="feature-list">
            <li><strong>Temperature in tray icon</strong> — displayed as text directly on the icon (for example, <code>5°</code>, <code>-3°</code>)</li>
            <li><strong>Automatic updates</strong> — the temperature refreshes every minute</li>
            <li><strong>Flexible location settings</strong> — specify coordinates or a city and country</li>
            <li><strong>Last update time</strong> — shown in the tooltip and menu to the second</li>
            <li><strong>Location information</strong> — coordinates, city, and country in the context menu</li>
            <li><strong>API error history</strong> — the latest 20 errors are saved for debugging</li>
          </ul>
        </div>

        <div class="section">
          <h2>📍 Location settings</h2>
          <p>Settings are stored in <code>settings.json</code> in the project root. The file is created automatically with default values on first launch.</p>
          
          <div style="background: #fff3cd; border: 1px solid #ffc107; border-radius: 4px; padding: 12px; margin-bottom: 16px;">
            <p style="margin: 0; color: #856404; font-weight: 500;"><strong>⚠️ Important:</strong> By default, the temperature is shown for <strong>New York City, United States</strong>. To show the weather for your location, update settings in the dialog "Settings" or edit the file <code>settings.json</code> manually.</p>
          </div>
          
          <h3>⚙️ Settings dialog (recommended)</h3>
          <p>Instead of editing <code>settings.json</code> you can use the settings dialog:</p>
          <ol>
            <li>Right-click the tray icon</li>
            <li>Select <strong>"Settings"</strong></li>
            <li>Fill in the required fields in the window that opens</li>
            <li>Click <strong>"Save"</strong></li>
          </ol>
          <p>The dialog validates and applies the settings. The app continues running with the new settings; no restart is required.</p>
          
          <h3>📝 Edit settings.json manually</h3>
          <p>Alternatively, edit <code>settings.json</code> manually. Specify one of the following:</p>
          
          <h4>Option 1: Specify a city and country</h4>
          <p>Edit <code>settings.json</code>:</p>
          <pre>{
  "city": "Minsk",
  "country": "Belarus",
  "latitude": null,
  "longitude": null,
  "updateIntervalInSeconds": 60
}</pre>
          <p>Coordinates are looked up automatically through the Geocoding API.</p>

          <h4>Option 2: Specify coordinates directly</h4>
          <p>Edit <code>settings.json</code>:</p>
          <pre>{
  "city": null,
  "country": null,
  "latitude": 55.7558,
  "longitude": 37.6173,
  "updateIntervalInSeconds": 60
}</pre>
          <p>The city and country names are looked up automatically from the coordinates.</p>
        </div>

        <div class="section">
          <h2>💡 Displayed information</h2>
          
          <h3>Tray icon</h3>
          <p>The temperature is displayed <span class="highlight">directly on the icon</span> as text. The icon refreshes every minute.</p>

          <h3>Tooltip (on hover)</h3>
          <p>Shows:</p>
          <ul>
            <li>The city and country, if available</li>
            <li>The current temperature</li>
            <li>The time of the last successful update, including seconds</li>
          </ul>
          <p>Example: <code>New York, United States\nTemperature: 0.2 °C (updated: 14:35:42)</code></p>

          <h3>Context menu (right-click)</h3>
          <p>Contains:</p>
          <ul>
            <li>The current temperature</li>
            <li>Last update time</li>
            <li>Coordinates (latitude and longitude)</li>
            <li>The city and country, if available</li>
            <li><strong>"Refresh now"</strong> to refresh manually</li>
            <li><strong>"Show API errors (N)"</strong> to view error history</li>
            <li><strong>"Quit"</strong></li>
          </ul>
        </div>

        <div class="section">
          <h2>🐛 API error history</h2>
          <p>The app saves the latest 20 API errors. To view them:</p>
          <ol>
            <li>Right-click the tray icon</li>
            <li>Select <strong>"Show API errors (N)"</strong></li>
            <li>A window opens with details about each error:
              <ul>
                <li>Time of occurrence</li>
                <li>API name</li>
                <li>Error message</li>
                <li>Request URL, if available</li>
              </ul>
            </li>
          </ol>
        </div>

        <div class="section">
          <h2>🔧 Technical details</h2>
          <ul>
            <li><strong>Language:</strong> TypeScript</li>
            <li><strong>Framework:</strong> Electron</li>
            <li><strong>Weather API:</strong> <a href="https://api.open-meteo.com" class="url-link">Open-Meteo</a> (free, no API key required)</li>
            <li><strong>Geocoding API:</strong> <a href="https://geocoding-api.open-meteo.com" class="url-link">Open-Meteo Geocoding</a></li>
            <li><strong>Icon generation:</strong> Canvas (to render the temperature text)</li>
            <li><strong>Configuration:</strong> <code>settings.json</code> file</li>
          </ul>
        </div>
      </div>
    </body>
    </html>
  `;

  // Check whether the window is already open
  if (helpWindow && !helpWindow.isDestroyed()) {
    if (helpWindow.isMinimized()) {
      helpWindow.restore();
    }
    helpWindow.show();
    helpWindow.focus();
    return;
  }

  // Create the help window
  const windowSize = { width: 700, height: 700 };
  const windowPosition = getWindowPositionOnPrimaryDisplay(windowSize.width, windowSize.height);
  helpWindow = new BrowserWindow({
    width: windowSize.width,
    height: windowSize.height,
    x: windowPosition.x,
    y: windowPosition.y,
    title: "How to use — Tray Weather",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Clear the reference when the window closes
  helpWindow.on('closed', () => {
    helpWindow = null;
  });

  // Load the HTML content
  helpWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  // Handle link clicks through webContents
  helpWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Handle navigation (if the user clicks a link)
  helpWindow.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    shell.openExternal(url);
  });
}

/**
 * Show the detailed weather and forecast window
 */
async function showWeatherDetails(): Promise<void> {
  // If the window is already open, close it
  if (weatherWindow && !weatherWindow.isDestroyed()) {
    weatherWindow.close();
    return;
  }

  // Prevent rapid tray clicks from starting concurrent requests that create duplicate windows.
  if (isWeatherDetailsOpening) {
    return;
  }
  isWeatherDetailsOpening = true;

  try {
  const weatherData = await fetchExtendedWeatherData();
  
  if (!weatherData) {
    dialog.showMessageBox({
      type: "error",
      title: "Error",
      message: "Could not load weather data",
      detail: "Try refreshing the data later.",
    });
    return;
  }

  const locationString = cityName && countryName ? `${cityName}, ${countryName}` : 
                        (LATITUDE !== null && LONGITUDE !== null ? `${LATITUDE.toFixed(4)}, ${LONGITUDE.toFixed(4)}` : "Unknown");
  
  // Helper functions for formatting
  const getWindDirection = (degrees: number): string => {
    const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    const index = Math.round(degrees / 45) % 8;
    return directions[index];
  };
  
  const getWindDescription = (speed: number): string => {
    if (speed < 0.5) return "calm";
    if (speed < 1.6) return "light breeze";
    if (speed < 3.4) return "light wind";
    if (speed < 5.5) return "gentle breeze";
    if (speed < 8.0) return "moderate wind";
    if (speed < 10.8) return "fresh breeze";
    if (speed < 13.9) return "strong wind";
    if (speed < 17.2) return "near gale";
    if (speed < 20.8) return "very near gale";
    if (speed < 24.5) return "storm";
    if (speed < 28.5) return "strong storm";
    if (speed < 32.7) return "violent storm";
    return "hurricane";
  };
  
  const getUVDescription = (uv: number): string => {
    if (uv < 3) return "Low";
    if (uv < 6) return "Moderate";
    if (uv < 8) return "High";
    if (uv < 11) return "Very high";
    return "Extreme";
  };
  
  const getComfortLevel = (dewpoint: number, humidity?: number): string => {
    if (dewpoint < 10) return "Dry";
    if (dewpoint < 16) return "Comfortable";
    if (dewpoint < 18) return "Moderate";
    if (dewpoint < 21) return "Humid";
    return "Very humid";
  };
  
  const getTimezoneSuffix = (): string => {
    const offsetSeconds = typeof weatherData.timezone === "number"
      ? weatherData.timezone
      : weatherData.utc_offset_seconds;
    if (offsetSeconds === undefined) return "";
    const hours = Math.floor(Math.abs(offsetSeconds) / 3600);
    const minutes = Math.floor((Math.abs(offsetSeconds) % 3600) / 60);
    const sign = offsetSeconds >= 0 ? "+" : "-";
    return ` (UTC${sign}${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")})`;
  };

  const formatDateTime = (value: string): string => {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?/);
    if (!match) return `${escapeHtml(value)}${getTimezoneSuffix()}`;
    return `${match[1]}<br>${match[2]}:${match[3] ?? "00"}${getTimezoneSuffix()}`;
  };

  const formatTime = (timeStr: string): string => formatDateTime(timeStr);
  
  const calculateDaylight = (sunrise: string, sunset: string): string => {
    const rise = new Date(sunrise);
    const set = new Date(sunset);
    const diff = set.getTime() - rise.getTime();
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    return `${hours}:${minutes.toString().padStart(2, "0")}`;
  };
  
  const timeStr = formatDateTime(weatherData.current.time);


  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Detailed weather information</title>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
          font-size: 14px;
          line-height: 1.6;
          color: #333;
          background: #f5f5f5;
          padding: 20px;
        }
        .container {
          max-width: 800px;
          margin: 0 auto;
          background: #fff;
          border-radius: 8px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
          padding: 24px;
        }
        .header {
          margin-bottom: 24px;
          padding-bottom: 16px;
          border-bottom: 2px solid #e0e0e0;
        }
        .header h1 {
          font-size: 24px;
          font-weight: 600;
          color: #1976d2;
          margin-bottom: 8px;
        }
        .header .location {
          color: #666;
          font-size: 16px;
        }
        .current-weather {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: #fff;
          padding: 24px;
          border-radius: 8px;
          margin-bottom: 24px;
        }
        .current-weather-content {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .current-temp {
          font-size: 64px;
          font-weight: 300;
          line-height: 1;
        }
        .current-info {
          text-align: right;
        }
        .current-emoji {
          font-size: 64px;
          line-height: 1;
        }
        .current-description {
          font-size: 18px;
          margin-top: 8px;
          opacity: 0.9;
        }
        .current-details {
          margin-top: 16px;
          padding-top: 16px;
          border-top: 1px solid rgba(255,255,255,0.3);
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 16px;
          font-size: 14px;
        }
        .current-detail-item {
          display: flex;
          flex-direction: column;
        }
        .current-detail-label {
          opacity: 0.8;
          font-size: 12px;
          margin-bottom: 4px;
        }
        .current-detail-value {
          font-weight: 600;
        }
        .forecast-section {
          margin-top: 24px;
        }
        .forecast-section h2 {
          font-size: 20px;
          font-weight: 600;
          color: #1976d2;
          margin-bottom: 16px;
        }
        .hourly-forecast {
          background: #f9f9f9;
          border: 1px solid #e0e0e0;
          border-radius: 8px;
          padding: 16px;
          margin-top: 24px;
        }
        .hourly-forecast h2 {
          font-size: 20px;
          font-weight: 600;
          color: #1976d2;
          margin-bottom: 16px;
        }
        .hourly-list {
          display: flex;
          gap: 12px;
          overflow-x: auto;
          padding-bottom: 8px;
        }
        .hourly-item {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          min-width: 70px;
          padding: 12px 8px;
          background: #fff;
          border-radius: 8px;
          border: 1px solid #e0e0e0;
        }
        .hourly-time {
          font-size: 12px;
          color: #666;
          font-weight: 500;
        }
        .hourly-emoji {
          font-size: 24px;
        }
        .hourly-temp {
          font-size: 16px;
          font-weight: 600;
          color: #333;
        }
        .hourly-list::-webkit-scrollbar {
          height: 6px;
        }
        .hourly-list::-webkit-scrollbar-track {
          background: #f1f1f1;
          border-radius: 3px;
        }
        .hourly-list::-webkit-scrollbar-thumb {
          background: #888;
          border-radius: 3px;
        }
        .hourly-list::-webkit-scrollbar-thumb:hover {
          background: #555;
        }
        .forecast-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .forecast-day {
          background: #f9f9f9;
          border: 1px solid #e0e0e0;
          border-radius: 8px;
          padding: 16px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .forecast-day-header {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .forecast-day-name {
          font-weight: 600;
          font-size: 16px;
          color: #333;
        }
        .forecast-emoji {
          font-size: 32px;
        }
        .forecast-day-info {
          display: flex;
          align-items: center;
          gap: 16px;
        }
        .forecast-description {
          color: #666;
          font-size: 14px;
        }
        .forecast-temp {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .temp-max {
          font-size: 20px;
          font-weight: 600;
          color: #333;
        }
        .temp-min {
          font-size: 18px;
          color: #999;
        }
        .update-time {
          margin-top: 16px;
          padding-top: 16px;
          border-top: 1px solid #e0e0e0;
          color: #666;
          font-size: 12px;
          text-align: center;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🌡️ Detailed weather information</h1>
          <div class="location">📍 ${locationString}</div>
          <div style="margin-top: 8px; font-size: 12px; color: #666;">
            API: ${API_PROVIDER === 'openweathermap' ? 'OpenWeatherMap' : 'Open-Meteo'}
            ${API_PROVIDER === 'openweathermap' && weatherData.cityId ? ` | <a href="https://old.openweathermap.org/city/${weatherData.cityId}" target="_blank" style="color: #1976d2; text-decoration: none;">Open in OpenWeatherMap</a>` : ''}
          </div>
        </div>
        
        <div class="current-weather">
          <div class="current-weather-content">
            <div>
              <div class="current-temp">${weatherData.current.temperature}°</div>
              <div class="current-description">${getWeatherDescription(weatherData.current.weathercode)}</div>
            </div>
            <div class="current-emoji">${getWeatherEmoji(weatherData.current.weathercode)}</div>
          </div>
          <div class="current-details">
            ${weatherData.current.apparent_temperature !== undefined ? `
            <div class="current-detail-item">
              <div class="current-detail-label">Feels like</div>
              <div class="current-detail-value">${weatherData.current.apparent_temperature}°</div>
            </div>
            ` : ''}
            <div class="current-detail-item">
              <div class="current-detail-label">Wind</div>
              <div class="current-detail-value">${getWindDirection(weatherData.current.winddirection)} ${weatherData.current.winddirection}°, ${weatherData.current.windspeed} m/s ${getWindDescription(weatherData.current.windspeed)}</div>
            </div>
            ${weatherData.current.cloudcover !== undefined ? `
            <div class="current-detail-item">
              <div class="current-detail-label">Cloud cover</div>
              <div class="current-detail-value">${weatherData.current.cloudcover}% ${weatherData.current.cloudcover >= 75 ? "overcast" : weatherData.current.cloudcover >= 50 ? "cloudy" : "mostly clear"}</div>
            </div>
            ` : ''}
            ${weatherData.current.surface_pressure !== undefined ? `
            <div class="current-detail-item">
              <div class="current-detail-label">Pressure</div>
              <div class="current-detail-value">${weatherData.current.surface_pressure} hPa</div>
            </div>
            ` : ''}
            ${weatherData.current.relativehumidity_2m !== undefined ? `
            <div class="current-detail-item">
              <div class="current-detail-label">Humidity</div>
              <div class="current-detail-value">${weatherData.current.relativehumidity_2m}%</div>
            </div>
            ` : ''}
            ${weatherData.current.visibility !== undefined ? `
            <div class="current-detail-item">
              <div class="current-detail-label">Visibility</div>
              <div class="current-detail-value">${weatherData.current.visibility} km</div>
            </div>
            ` : ''}
            ${weatherData.current.dewpoint_2m !== undefined ? `
            <div class="current-detail-item">
              <div class="current-detail-label">Dew point</div>
              <div class="current-detail-value">${weatherData.current.dewpoint_2m}°</div>
            </div>
            ` : ''}
            ${weatherData.current.dewpoint_2m !== undefined ? `
            <div class="current-detail-item">
              <div class="current-detail-label">Comfort</div>
              <div class="current-detail-value">${getComfortLevel(weatherData.current.dewpoint_2m, weatherData.current.relativehumidity_2m)}</div>
            </div>
            ` : ''}
            ${weatherData.current.precipitation !== undefined ? `
            <div class="current-detail-item">
              <div class="current-detail-label">Precipitation</div>
              <div class="current-detail-value">${weatherData.current.precipitation > 0 ? weatherData.current.precipitation + " mm" : "none"}</div>
            </div>
            ` : ''}
            ${weatherData.daily[0]?.sunrise ? `
            <div class="current-detail-item">
              <div class="current-detail-label">Sunrise</div>
              <div class="current-detail-value">${formatTime(weatherData.daily[0].sunrise)}</div>
            </div>
            ` : ''}
            ${weatherData.daily[0]?.sunset ? `
            <div class="current-detail-item">
              <div class="current-detail-label">Sunset</div>
              <div class="current-detail-value">${formatTime(weatherData.daily[0].sunset)}</div>
            </div>
            ` : ''}
            ${weatherData.daily[0]?.sunrise && weatherData.daily[0]?.sunset ? `
            <div class="current-detail-item">
              <div class="current-detail-label">Daylight</div>
              <div class="current-detail-value">${calculateDaylight(weatherData.daily[0].sunrise, weatherData.daily[0].sunset)}</div>
            </div>
            ` : ''}
            ${weatherData.current.uv_index !== undefined ? `
            <div class="current-detail-item">
              <div class="current-detail-label">UV index</div>
              <div class="current-detail-value">${weatherData.current.uv_index} ${getUVDescription(weatherData.current.uv_index)}</div>
            </div>
            ` : ''}
            <div class="current-detail-item">
              <div class="current-detail-label">Update time</div>
              <div class="current-detail-value">${timeStr}</div>
            </div>
          </div>
        </div>
        
        <div class="update-time">
          Data updated: ${timeStr}
        </div>
      </div>
    </body>
    </html>
  `;

  const windowSize = { width: 700, height: 800 };
  const windowPosition = getWindowPositionOnPrimaryDisplay(windowSize.width, windowSize.height);
  weatherWindow = new BrowserWindow({
    width: windowSize.width,
    height: windowSize.height,
    x: windowPosition.x,
    y: windowPosition.y,
    title: "Detailed weather information — Tray Weather",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    resizable: true,
  });

  // Clear the reference when the window closes
  weatherWindow.on('closed', () => {
    weatherWindow = null;
  });

  // Handle link clicks through webContents
  weatherWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Handle navigation (if the user clicks a link)
  weatherWindow.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    shell.openExternal(url);
  });

  weatherWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  } finally {
    isWeatherDetailsOpening = false;
  }
}

/**
 * Show the most recent API requests window
 */
function showApiRequests(): void {
  // Check whether the window is already open
  if (requestWindow && !requestWindow.isDestroyed()) {
    if (requestWindow.isMinimized()) {
      requestWindow.restore();
    }
    requestWindow.show();
    requestWindow.focus();
    return;
  }

  // Format requests for display in HTML
  const requestsHtml = apiRequests.length === 0
    ? '<div style="text-align: center; padding: 40px; color: #666; font-size: 14px;"><p style="margin-bottom: 8px; font-weight: 500;">No requests</p><p style="font-size: 12px; color: #999;">The request history is empty.</p></div>'
    : apiRequests
    .slice()
    .reverse() // Show the most recent requests first
    .map((req, index) => {
      const timeStr = req.timestamp.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      
      const escapedUrl = escapeHtml(req.url);
      const escapedApi = escapeHtml(req.api);
      
      let requestHeadersHtml = "";
      if (req.requestHeaders && Object.keys(req.requestHeaders).length > 0) {
        const headersStr = Object.entries(req.requestHeaders)
          .map(([key, value]) => `${escapeHtml(key)}: ${escapeHtml(value)}`)
          .join("\n");
        requestHeadersHtml = `<div class="request-section">
          <div class="request-section-title">Request headers:</div>
          <pre class="request-pre">${headersStr}</pre>
        </div>`;
      } else {
        requestHeadersHtml = `<div class="request-section">
          <div class="request-section-title">Request headers:</div>
          <pre class="request-pre">(no headers)</pre>
        </div>`;
      }
      
      let responseStatusHtml = "";
      if (req.responseStatus) {
        const statusText = req.responseStatus === 200 ? "OK" :
                          req.responseStatus === 404 ? "Not Found" :
                          req.responseStatus === 403 ? "Forbidden" :
                          req.responseStatus === 500 ? "Internal Server Error" :
                          req.responseStatus === 503 ? "Service Unavailable" :
                          req.responseStatus === 429 ? "Too Many Requests" :
                          "Unknown";
        responseStatusHtml = `<div class="request-section">
          <div class="request-section-title">HTTP status:</div>
          <div class="status-code status-${req.responseStatus}">${req.responseStatus} ${statusText}</div>
        </div>`;
      }
      
      let responseHeadersHtml = "";
      if (req.responseHeaders && Object.keys(req.responseHeaders).length > 0) {
        const headersStr = Object.entries(req.responseHeaders)
          .map(([key, value]) => `${escapeHtml(key)}: ${escapeHtml(value)}`)
          .join("\n");
        responseHeadersHtml = `<div class="request-section">
          <div class="request-section-title">Response headers:</div>
          <pre class="request-pre">${headersStr}</pre>
        </div>`;
      }
      
      let responseBodyHtml = "";
      if (req.responseBody) {
        const bodyStr = escapeHtml(req.responseBody);
        responseBodyHtml = `<div class="request-section">
          <div class="request-section-title">Response body:</div>
          <pre class="request-pre response-body">${bodyStr}</pre>
        </div>`;
      }
      
      const durationStr = req.duration !== undefined ? ` (${req.duration} ms)` : "";
      
      return `
        <div class="request-item">
          <div class="request-number">${apiRequests.length - index}.</div>
          <div class="request-content">
            <div class="request-time">[${timeStr}]${durationStr}</div>
            <div class="request-api"><strong>${escapedApi}</strong></div>
            <div class="request-url"><strong>URL:</strong> <a href="${escapedUrl}" class="url-link">${escapedUrl}</a></div>
            <div class="request-method"><strong>Method:</strong> ${escapeHtml(req.method)}</div>
            ${requestHeadersHtml}
            ${responseStatusHtml}
            ${responseHeadersHtml}
            ${responseBodyHtml}
          </div>
        </div>
      `;
    })
    .join("");

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>API request history (${apiRequests.length} of ${MAX_REQUESTS} maximum stored)</title>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
          font-size: 13px;
          line-height: 1.5;
          color: #333;
          background: #fff;
          padding: 16px;
        }
        .header {
          margin-bottom: 16px;
          padding-bottom: 12px;
          border-bottom: 2px solid #e0e0e0;
        }
        .header h1 {
          font-size: 18px;
          font-weight: 600;
          color: #1976d2;
        }
        .request-list {
          max-height: calc(100vh - 100px);
          overflow-y: auto;
          overflow-x: hidden;
        }
        .request-item {
          display: flex;
          margin-bottom: 20px;
          padding: 16px;
          background: #f9f9f9;
          border-left: 3px solid #1976d2;
          border-radius: 4px;
        }
        .request-number {
          font-weight: bold;
          color: #666;
          margin-right: 12px;
          min-width: 24px;
        }
        .request-content {
          flex: 1;
        }
        .request-time {
          color: #666;
          font-size: 11px;
          margin-bottom: 4px;
        }
        .request-api {
          color: #1976d2;
          margin-bottom: 6px;
          font-size: 14px;
        }
        .request-url {
          color: #333;
          margin-bottom: 6px;
          word-break: break-all;
        }
        .request-method {
          color: #666;
          margin-bottom: 12px;
          font-size: 12px;
        }
        .request-section {
          margin-top: 12px;
          margin-bottom: 8px;
        }
        .request-section-title {
          font-weight: 600;
          color: #424242;
          margin-bottom: 4px;
          font-size: 12px;
        }
        .request-pre {
          background: #fafafa;
          padding: 8px;
          border-radius: 3px;
          font-size: 11px;
          margin-top: 4px;
          overflow-x: auto;
          white-space: pre-wrap;
          word-break: break-word;
          border: 1px solid #e0e0e0;
        }
        .response-body {
          max-height: 300px;
          overflow-y: auto;
        }
        .status-code {
          padding: 4px 8px;
          border-radius: 3px;
          font-weight: 600;
          display: inline-block;
          margin-top: 4px;
        }
        .status-200 {
          background: #e8f5e9;
          color: #2e7d32;
        }
        .status-404, .status-403, .status-500, .status-503, .status-429 {
          background: #ffebee;
          color: #c62828;
        }
        .url-link {
          color: #1976d2;
          text-decoration: none;
        }
        .url-link:hover {
          text-decoration: underline;
        }
        .url-link:visited {
          color: #7b1fa2;
        }
        .request-list::-webkit-scrollbar {
          width: 10px;
        }
        .request-list::-webkit-scrollbar-track {
          background: #f1f1f1;
          border-radius: 5px;
        }
        .request-list::-webkit-scrollbar-thumb {
          background: #888;
          border-radius: 5px;
        }
        .request-list::-webkit-scrollbar-thumb:hover {
          background: #555;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>API request history (${apiRequests.length} of ${MAX_REQUESTS} maximum stored)</h1>
      </div>
      <div class="request-list">
        ${requestsHtml}
      </div>
    </body>
    </html>
  `;

  const windowSize = { width: 900, height: 700 };
  const windowPosition = getWindowPositionOnPrimaryDisplay(windowSize.width, windowSize.height);
  requestWindow = new BrowserWindow({
    width: windowSize.width,
    height: windowSize.height,
    x: windowPosition.x,
    y: windowPosition.y,
    title: `API request history (${apiRequests.length} of ${MAX_REQUESTS})`,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Clear the reference when the window closes
  requestWindow.on('closed', () => {
    requestWindow = null;
  });

  requestWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  // Handle link clicks
  requestWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  requestWindow.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    shell.openExternal(url);
  });
}

/**
 * Show the recent API errors window (with scrolling and clickable links)
 */
function showApiErrors(): void {
  // Check whether the window is already open
  if (errorWindow && !errorWindow.isDestroyed()) {
    if (errorWindow.isMinimized()) {
      errorWindow.restore();
    }
    errorWindow.show();
    errorWindow.focus();
    return;
  }

  // Format errors for display in HTML
  const errorsHtml = apiErrors.length === 0
    ? '<div style="text-align: center; padding: 40px; color: #666; font-size: 14px;"><p style="margin-bottom: 8px; font-weight: 500;">No errors</p><p style="font-size: 12px; color: #999;">All API requests completed successfully.</p></div>'
    : apiErrors
    .map((err, index) => {
      const timeStr = err.timestamp.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      
      let urlHtml = "";
      if (err.url) {
        const escapedUrl = escapeHtml(err.url);
        urlHtml = `<div class="error-url"><strong>URL:</strong> <a href="${escapedUrl}" class="url-link">${escapedUrl}</a></div>`;
      }
      
      let statusCodeHtml = "";
      if (err.statusCode) {
        const statusText = err.statusCode === 404 ? "Not Found" :
                          err.statusCode === 403 ? "Forbidden" :
                          err.statusCode === 500 ? "Internal Server Error" :
                          err.statusCode === 503 ? "Service Unavailable" :
                          err.statusCode === 429 ? "Too Many Requests" :
                          "Unknown";
        statusCodeHtml = `<div class="error-status"><strong>HTTP status:</strong> <span class="status-code status-${err.statusCode}">${err.statusCode} ${statusText}</span></div>`;
      }
      
      let errorCodeHtml = "";
      if (err.errorCode) {
        const errorCodeDesc = err.errorCode === "ENOTFOUND" ? " (DNS lookup failed - host could not be found)" :
                             err.errorCode === "ECONNREFUSED" ? " (Connection refused - connection was refused)" :
                             err.errorCode === "ETIMEDOUT" ? " (Timeout - request timed out)" :
                             err.errorCode === "ECONNRESET" ? " (Connection reset - connection was reset)" :
                             err.errorCode === "EAI_AGAIN" ? " (DNS lookup failed - temporary DNS error)" :
                             "";
        errorCodeHtml = `<div class="error-code"><strong>Error code:</strong> <span class="code-value">${err.errorCode}${errorCodeDesc}</span></div>`;
      }
      
      let detailsHtml = "";
      if (err.details) {
        const escapedDetails = escapeHtml(err.details);
        detailsHtml = `<div class="error-details"><strong>Details:</strong><pre class="details-pre">${escapedDetails}</pre></div>`;
      }
      
      const escapedApi = escapeHtml(err.api);
      const escapedError = escapeHtml(err.error);
      
      return `
        <div class="error-item">
          <div class="error-number">${index + 1}.</div>
          <div class="error-content">
            <div class="error-time">[${timeStr}]</div>
            <div class="error-api"><strong>${escapedApi}</strong></div>
            <div class="error-message">${escapedError}</div>
            ${statusCodeHtml}
            ${errorCodeHtml}
            ${urlHtml}
            ${detailsHtml}
          </div>
        </div>
      `;
    })
    .join("");

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>API error history (${apiErrors.length} of ${MAX_ERRORS} maximum stored)</title>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
          font-size: 13px;
          line-height: 1.5;
          color: #333;
          background: #fff;
          padding: 16px;
        }
        .header {
          margin-bottom: 16px;
          padding-bottom: 12px;
          border-bottom: 2px solid #e0e0e0;
        }
        .header h1 {
          font-size: 18px;
          font-weight: 600;
          color: #d32f2f;
        }
        .error-list {
          max-height: calc(100vh - 100px);
          overflow-y: auto;
          overflow-x: hidden;
        }
        .error-item {
          display: flex;
          margin-bottom: 16px;
          padding: 12px;
          background: #f5f5f5;
          border-left: 3px solid #d32f2f;
          border-radius: 4px;
        }
        .error-number {
          font-weight: bold;
          color: #666;
          margin-right: 12px;
          min-width: 24px;
        }
        .error-content {
          flex: 1;
        }
        .error-time {
          color: #666;
          font-size: 11px;
          margin-bottom: 4px;
        }
        .error-api {
          color: #d32f2f;
          margin-bottom: 6px;
        }
        .error-message {
          color: #333;
          white-space: pre-wrap;
          word-break: break-word;
          margin-bottom: 8px;
        }
        .error-status, .error-code, .error-url, .error-details {
          margin-top: 8px;
          font-size: 12px;
        }
        .status-code {
          padding: 2px 6px;
          border-radius: 3px;
          font-weight: 600;
        }
        .status-404 {
          background: #ffebee;
          color: #c62828;
        }
        .status-403 {
          background: #fff3e0;
          color: #e65100;
        }
        .status-500 {
          background: #fce4ec;
          color: #c2185b;
        }
        .status-503 {
          background: #fff9c4;
          color: #f57f17;
        }
        .status-429 {
          background: #fff3e0;
          color: #f57c00;
        }
        .code-value {
          font-family: "Courier New", monospace;
          color: #d32f2f;
          font-weight: 600;
        }
        .details-pre {
          background: #fafafa;
          padding: 8px;
          border-radius: 3px;
          font-size: 11px;
          margin-top: 4px;
          overflow-x: auto;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .url-link {
          color: #1976d2;
          text-decoration: none;
        }
        .url-link:hover {
          text-decoration: underline;
        }
        .url-link:visited {
          color: #7b1fa2;
        }
        /* Scrollbar styles */
        .error-list::-webkit-scrollbar {
          width: 10px;
        }
        .error-list::-webkit-scrollbar-track {
          background: #f1f1f1;
          border-radius: 5px;
        }
        .error-list::-webkit-scrollbar-thumb {
          background: #888;
          border-radius: 5px;
        }
        .error-list::-webkit-scrollbar-thumb:hover {
          background: #555;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>API error history (${apiErrors.length} of ${MAX_ERRORS} maximum stored)</h1>
      </div>
      <div class="error-list">
        ${errorsHtml}
      </div>
    </body>
    </html>
  `;

  // Create the error history window
  const windowSize = { width: 800, height: 600 };
  const windowPosition = getWindowPositionOnPrimaryDisplay(windowSize.width, windowSize.height);
  errorWindow = new BrowserWindow({
    width: windowSize.width,
    height: windowSize.height,
    x: windowPosition.x,
    y: windowPosition.y,
    title: `API error history (${apiErrors.length} of ${MAX_ERRORS})`,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Clear the reference when the window closes
  errorWindow.on('closed', () => {
    errorWindow = null;
  });

  // Load the HTML content
  errorWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  // Handle link clicks through webContents
  errorWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Handle navigation (if the user clicks a link)
  errorWindow.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    shell.openExternal(url);
  });
}

/**
 * Look up coordinates for a city and country through the Geocoding API
 */
async function fetchCoordinatesByCity(city: string, country: string): Promise<{ latitude: number; longitude: number; cityName: string; countryName: string } | null> {
  // Use count=10 to get more results and find the best match
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&country=${encodeURIComponent(country)}&count=10&language=en`;
  console.log({url});
  const startTime = Date.now();
  try {
    const res = await fetch(url);
    const duration = Date.now() - startTime;
    
    // Get the response headers
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    
    // Get the response body
    const responseText = await res.text();
    let responseBody: string | undefined;
    try {
      const jsonData = JSON.parse(responseText);
      responseBody = JSON.stringify(jsonData, null, 2);
    } catch {
      responseBody = responseText;
    }
    
    if (!res.ok) {
      const error = new Error(`HTTP error ${res.status} ${res.statusText}`);
      addApiError("Geocoding API (coordinate lookup)", error, url, { statusCode: res.status });
      addApiRequest("Geocoding API (coordinate lookup)", url, "GET", undefined, res.status, responseHeaders, responseBody, duration);
      return null;
    }
    
    addApiRequest("Geocoding API (coordinate lookup)", url, "GET", undefined, res.status, responseHeaders, responseBody, duration);
    
    const data: any = JSON.parse(responseText);
    if (data && data.results && data.results.length > 0) {
      // Normalize names for comparison
      const cityLower = city.toLowerCase().trim();
      const countryLower = country.toLowerCase().trim();
      
      // Helper to normalize a country name (trim extra spaces and convert to lowercase)
      const normalizeCountry = (countryName: string): string => {
        return countryName.toLowerCase().trim();
      };
      
      // First, look for an exact match on both city and country
      const exactMatchWithCountry = data.results.find((loc: any) => {
        const locCity = loc.name ? loc.name.toLowerCase().trim() : "";
        const locCountry = loc.country ? normalizeCountry(loc.country) : "";
        return locCity === cityLower && locCountry === countryLower;
      });
      
      if (exactMatchWithCountry) {
        return {
          latitude: exactMatchWithCountry.latitude,
          longitude: exactMatchWithCountry.longitude,
          cityName: exactMatchWithCountry.name || city,
          countryName: exactMatchWithCountry.country || country,
        };
      }
      
      // If no exact city and country match is found, look for an exact city match
      const exactMatchCity = data.results.find((loc: any) => 
        loc.name && loc.name.toLowerCase().trim() === cityLower
      );
      
      // Use the exact city match if found; otherwise, use the first result
      const location = exactMatchCity || data.results[0];
      
      return {
        latitude: location.latitude,
        longitude: location.longitude,
        cityName: location.name || city,
        countryName: location.country || country,
      };
    }
    return null;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    // Extract the error code, if present
    const errorCode = (err as any)?.code;
    addApiError("Geocoding API (coordinate lookup)", error, url, errorCode ? { errorCode } : undefined);
    console.error("Failed to fetch coordinates:", err);
    return null;
  }
}

/**
 * Get the city and country names for coordinates through the Geocoding API
 */
async function fetchLocationByCoordinates(latitude: number, longitude: number): Promise<{ cityName: string; countryName: string } | null> {
  // Use Nominatim (OpenStreetMap) for reverse geocoding because Open-Meteo does not support it
  // Nominatim is free and does not require an API key
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&addressdetails=1&accept-language=ru`;
  console.log({url});
  const startTime = Date.now();
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'WeatherApp/1.0' // Nominatim requires a User-Agent
      }
    });
    const duration = Date.now() - startTime;
    
    // Get the response headers
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    
    // Get the response body
    const responseText = await res.text();
    let responseBody: string | undefined;
    try {
      const jsonData = JSON.parse(responseText);
      responseBody = JSON.stringify(jsonData, null, 2);
    } catch {
      responseBody = responseText;
    }
    
    if (!res.ok) {
      const error = new Error(`HTTP error ${res.status} ${res.statusText}`);
      addApiError("Nominatim API (location lookup)", error, url, { statusCode: res.status });
      addApiRequest("Nominatim API (location lookup)", url, "GET", undefined, res.status, responseHeaders, responseBody, duration);
      return null;
    }
    
    addApiRequest("Nominatim API (location lookup)", url, "GET", undefined, res.status, responseHeaders, responseBody, duration);
    
    const data: any = JSON.parse(responseText);
    
    // Check whether the response contains an error
    if (data && data.error) {
      const errorMessage = data.error || "Unknown error from API";
      const error = new Error(`API error: ${errorMessage}`);
      addApiError("Nominatim API (location lookup)", error, url);
      console.error("API returned error:", errorMessage);
      return null;
    }
    
    // Nominatim returns data in the address format
    if (data && data.address) {
      const address = data.address;
      // Extract the city and country names from the address
      // Nominatim may return different fields depending on the location type
      const cityName = address.city || address.town || address.village || address.municipality || address.county || "";
      const countryName = address.country || "";
      
      if (cityName || countryName) {
        return {
          cityName: cityName,
          countryName: countryName,
        };
      }
    }
    
    // Missing data is not an error; there is simply no data for these coordinates
    console.log("No location found for coordinates:", latitude, longitude);
    return null;
  } catch (err) {
    const duration = Date.now() - startTime;
    const error = err instanceof Error ? err : new Error(String(err));
    // Extract the error code, if present
    const errorCode = (err as any)?.code;
    addApiError("Nominatim API (location lookup)", error, url, errorCode ? { errorCode } : undefined);
    addApiRequest("Nominatim API (location lookup)", url, "GET", undefined, undefined, undefined, undefined, duration);
    console.error("Failed to fetch location info:", err);
    return null;
  }
}

/**
 * Initialize coordinates and location names
 */
async function initializeLocation(): Promise<boolean> {
  const offlineTestMode = process.env.NODE_ENV === 'test' && process.env.WEATHER_TEST_NO_NETWORK === '1';

  // Use a stable test location so UI and tray tests do not depend on geocoding availability.
  if (offlineTestMode && (LATITUDE === null || LONGITUDE === null) && CITY && COUNTRY) {
    LATITUDE = 55.7558;
    LONGITUDE = 37.6173;
    cityName = CITY;
    countryName = COUNTRY;
  }

  // If coordinates are not set but a city and country are
  if ((LATITUDE === null || LONGITUDE === null) && CITY && COUNTRY) {
    console.log(`Looking up coordinates for ${CITY}, ${COUNTRY}...`);
    const location = await fetchCoordinatesByCity(CITY, COUNTRY);
    if (location) {
      LATITUDE = location.latitude;
      LONGITUDE = location.longitude;
      cityName = location.cityName;
      countryName = location.countryName;
      // Generate the URL based on the selected API provider
      if (API_PROVIDER === 'openweathermap' && API_KEY) {
        WEATHER_URL = `https://api.openweathermap.org/data/2.5/weather?lat=${LATITUDE}&lon=${LONGITUDE}&appid=${API_KEY}&units=metric`;
      } else {
        WEATHER_URL = `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}&current_weather=true&windspeed_unit=ms`;
      }
      console.log(`Coordinates resolved: ${LATITUDE}, ${LONGITUDE}`);
      console.log(`Location: ${cityName}, ${countryName}`);
      return true;
    } else {
      console.error("Could not determine coordinates");
      return false;
    }
  }
  // If coordinates are specified directly (in code or by a previous request)
  if (LATITUDE !== null && LONGITUDE !== null) {
    // Always update WEATHER_URL during initialization to use the current coordinates
    // Generate the URL based on the selected API provider
    if (API_PROVIDER === 'openweathermap' && API_KEY) {
      WEATHER_URL = `https://api.openweathermap.org/data/2.5/weather?lat=${LATITUDE}&lon=${LONGITUDE}&appid=${API_KEY}&units=metric`;
    } else {
      WEATHER_URL = `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}&current_weather=true&windspeed_unit=ms`;
    }
    console.log(`Using coordinates: ${LATITUDE}, ${LONGITUDE}`);
    
    // Get the city and country names from the coordinates
    // If only coordinates are used (CITY and COUNTRY are undefined), always look up the names
    // Also look them up if the names are not yet available
    if (offlineTestMode) {
      cityName = CITY || 'Moscow';
      countryName = COUNTRY || 'Russia';
    } else if ((CITY === undefined && COUNTRY === undefined) || !cityName || !countryName) {
      const location = await fetchLocationByCoordinates(LATITUDE, LONGITUDE);
      if (location) {
        cityName = location.cityName;
        countryName = location.countryName;
        console.log(`Location updated from coordinates: ${cityName}, ${countryName}`);
      }
    }
    return true;
  }
  
  const error = new Error("Neither coordinates nor city and country were specified!");
  addApiError("Initialization", error);
  console.error("Neither coordinates nor city and country were specified!");
  return false;
}

interface WeatherData {
  temperature: number;
  weathercode: number;
}

interface ExtendedWeatherData {
  current: {
    temperature: number;
    weathercode: number;
    windspeed: number;
    winddirection: number;
    time: string;
    apparent_temperature?: number;
    cloudcover?: number;
    surface_pressure?: number;
    relativehumidity_2m?: number;
    dewpoint_2m?: number;
    precipitation?: number;
    uv_index?: number;
    visibility?: number;
  };
  daily: Array<{
    date: string;
    temperature_max: number;
    temperature_min: number;
    weathercode: number;
    sunrise?: string;
    sunset?: string;
  }>;
  hourly: Array<{
    time: string;
    temperature: number;
    weathercode: number;
  }>;
  timezone?: string | number; // For OpenWeatherMap, a number (offset in seconds); for Open-Meteo, a string (timezone name)
  utc_offset_seconds?: number;
  cityId?: number; // OpenWeatherMap city ID (for the link)
}

async function fetchWeatherData(): Promise<WeatherData | null> {
  if (!WEATHER_URL) {
    const error = new Error("WEATHER_URL has not been initialized");
    addApiError("Weather API", error);
    console.error("WEATHER_URL has not been initialized");
    return null;
  }
  
  const startTime = Date.now();
  try {
    const res = await fetch(WEATHER_URL);
    const duration = Date.now() - startTime;
    
    // Get the response headers
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    
    // Get the response body
    const responseText = await res.text();
    let responseBody: string | undefined;
    try {
      const jsonData = JSON.parse(responseText);
      responseBody = JSON.stringify(jsonData, null, 2);
    } catch {
      responseBody = responseText;
    }
    
    if (!res.ok) {
      const error = new Error(`HTTP error ${res.status} ${res.statusText}`);
      addApiError("Weather API", error, WEATHER_URL, { statusCode: res.status });
      addApiRequest("Weather API", WEATHER_URL, "GET", undefined, res.status, responseHeaders, responseBody, duration);
      return null;
    }
    
    addApiRequest("Weather API", WEATHER_URL, "GET", undefined, res.status, responseHeaders, responseBody, duration);
    
    const data: any = JSON.parse(responseText);
    
    // Process the response based on the API provider
    if (API_PROVIDER === 'openweathermap') {
      // OpenWeatherMap API response format
      if (data && data.main && typeof data.main.temp === "number") {
        // Convert the OpenWeatherMap weather code to the WMO format
        const owmCode = data.weather && data.weather[0] && typeof data.weather[0].id === "number" 
          ? data.weather[0].id 
          : 800; // Clear by default (800 = Clear sky in OpenWeatherMap)
        const weathercode = convertOpenWeatherMapToWMO(owmCode);
        console.log(`OpenWeatherMap: code ${owmCode} converted to WMO ${weathercode}`);
        return {
          temperature: data.main.temp,
          weathercode: weathercode
        };
      }
    } else {
      // Open-Meteo API response format
      if (data && data.current_weather && typeof data.current_weather.temperature === "number") {
        const weathercode = typeof data.current_weather.weathercode === "number" 
          ? data.current_weather.weathercode 
          : 0;
        return {
          temperature: data.current_weather.temperature,
          weathercode: weathercode
        };
      }
    }
    
    const error = new Error("Invalid API response: temperature is missing");
    addApiError("Weather API", error, WEATHER_URL);
    return null;
  } catch (err) {
    const duration = Date.now() - startTime;
    const error = err instanceof Error ? err : new Error(String(err));
    // Extract the error code, if present
    const errorCode = (err as any)?.code;
    addApiError("Weather API", error, WEATHER_URL, errorCode ? { errorCode } : undefined);
    addApiRequest("Weather API", WEATHER_URL, "GET", undefined, undefined, undefined, undefined, duration);
    console.error("Failed to fetch weather:", err);
    return null;
  }
}

/**
 * Get extended weather data and forecast
 */
async function fetchExtendedWeatherData(): Promise<ExtendedWeatherData | null> {
  if (LATITUDE === null || LONGITUDE === null) {
    return null;
  }
  
  // URL for extended data, based on the API provider
  let extendedUrl: string;
  let currentWeatherUrl: string | null = null;
  if (API_PROVIDER === 'openweathermap' && API_KEY) {
    // For OpenWeatherMap, use ONLY current weather (/data/2.5/weather)
    // Do NOT use the /forecast API
    currentWeatherUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${LATITUDE}&lon=${LONGITUDE}&appid=${API_KEY}&units=metric`;
    extendedUrl = ""; // Not used for OpenWeatherMap
  } else {
    // Open-Meteo API: extended data with a 7-day forecast and hourly forecast for today
    // Include all available parameters: feels like, cloud cover, pressure, humidity, dew point, precipitation, and UV index
    extendedUrl = `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}&current_weather=true&daily=temperature_2m_max,temperature_2m_min,weathercode,sunrise,sunset&hourly=temperature_2m,weathercode,apparent_temperature,cloudcover,pressure_msl,relativehumidity_2m,dewpoint_2m,precipitation,uv_index&current=apparent_temperature,cloudcover,surface_pressure,relativehumidity_2m,dewpoint_2m,precipitation,uv_index,visibility&windspeed_unit=ms&timezone=auto&forecast_days=7`;
  }
  
  const startTime = Date.now();
  try {
    // For OpenWeatherMap, retrieve current weather only
    let currentWeatherData: any = null;
    if (API_PROVIDER === 'openweathermap' && currentWeatherUrl) {
      try {
        const currentStartTime = Date.now();
        const currentRes = await fetch(currentWeatherUrl);
        const currentDuration = Date.now() - currentStartTime;
        
        const currentText = await currentRes.text();
        let currentResponseBody: string | undefined;
        try {
          const currentJsonData = JSON.parse(currentText);
          currentResponseBody = JSON.stringify(currentJsonData, null, 2);
        } catch {
          currentResponseBody = currentText;
        }
        
        const currentResponseHeaders: Record<string, string> = {};
        currentRes.headers.forEach((value, key) => {
          currentResponseHeaders[key] = value;
        });
        
        if (currentRes.ok) {
          currentWeatherData = JSON.parse(currentText);
          addApiRequest("Weather API (current weather)", currentWeatherUrl, "GET", undefined, currentRes.status, currentResponseHeaders, currentResponseBody, currentDuration);
        } else {
          const error = new Error(`HTTP error ${currentRes.status} ${currentRes.statusText}`);
          addApiError("Weather API (current weather)", error, currentWeatherUrl, { statusCode: currentRes.status });
          addApiRequest("Weather API (current weather)", currentWeatherUrl, "GET", undefined, currentRes.status, currentResponseHeaders, currentResponseBody, currentDuration);
          console.error("Could not retrieve current weather from OpenWeatherMap");
          return null;
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        addApiError("Weather API (current weather)", error, currentWeatherUrl);
        console.error("Error retrieving current weather from OpenWeatherMap:", err);
        return null;
      }
      
      // For OpenWeatherMap, return current data only, without a forecast
      if (!currentWeatherData) {
        console.error("Could not retrieve current weather from OpenWeatherMap /weather API");
        return null;
      }
      
      const current = currentWeatherData;
      const currentMain = current.main || {};
      const currentWeather = current.weather && current.weather[0] ? current.weather[0] : {};
      const currentSys = current.sys || {};
      
      // Convert the current OpenWeatherMap weather code to WMO
      const currentOwmCode = currentWeather.id || 800;
      const currentWmoCode = convertOpenWeatherMapToWMO(currentOwmCode);
      
      // Convert sunrise and sunset from Unix timestamps to ISO strings
      const sunrise = currentSys.sunrise ? new Date(currentSys.sunrise * 1000).toISOString() : undefined;
      const sunset = currentSys.sunset ? new Date(currentSys.sunset * 1000).toISOString() : undefined;
      
      // Create a daily array with sunrise and sunset for display
      const dailyWithSun: Array<{ date: string; temperature_max: number; temperature_min: number; weathercode: number; sunrise?: string; sunset?: string }> = [];
      if (sunrise || sunset) {
        const today = new Date();
        const todayStr = today.toISOString().split('T')[0];
        dailyWithSun.push({
          date: todayStr,
          temperature_max: currentMain.temp || 0,
          temperature_min: currentMain.temp || 0,
          weathercode: currentWmoCode,
          sunrise: sunrise,
          sunset: sunset,
        });
      }
      
      return {
        current: {
          temperature: currentMain.temp || 0,
          weathercode: currentWmoCode,
          windspeed: current.wind ? (current.wind.speed || 0) : 0,
          winddirection: current.wind ? (current.wind.deg || 0) : 0,
          time: current.dt ? new Date(current.dt * 1000).toISOString() : new Date().toISOString(),
          apparent_temperature: currentMain.feels_like,
          cloudcover: current.clouds && typeof current.clouds.all === "number" ? current.clouds.all : undefined,
          surface_pressure: currentMain.pressure ? currentMain.pressure : undefined, // OpenWeatherMap returns pressure in hPa
          relativehumidity_2m: currentMain.humidity,
          dewpoint_2m: undefined, // OpenWeatherMap does not provide dew point directly
          precipitation: current.rain ? (current.rain['3h'] || 0) : undefined,
          uv_index: undefined, // OpenWeatherMap does not provide a UV index in the basic API
          visibility: current.visibility ? current.visibility / 1000 : undefined, // Convert from meters to kilometers
        },
        daily: dailyWithSun, // Add sunrise and sunset for display
        hourly: [], // No forecast is available from OpenWeatherMap
        timezone: current.timezone ? current.timezone : undefined,
        utc_offset_seconds: undefined,
        cityId: current.id, // Save the city ID for the OpenWeatherMap link
      };
    }
    
    // Make a request to extendedUrl for Open-Meteo
    const res = await fetch(extendedUrl);
    const duration = Date.now() - startTime;
    
    // Get the response headers
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    
    // Get the response body
    const responseText = await res.text();
    let responseBody: string | undefined;
    try {
      const jsonData = JSON.parse(responseText);
      responseBody = JSON.stringify(jsonData, null, 2);
    } catch {
      responseBody = responseText;
    }
    
    if (!res.ok) {
      const error = new Error(`HTTP error ${res.status} ${res.statusText}`);
      addApiError("Weather API (extended data)", error, extendedUrl, { statusCode: res.status });
      addApiRequest("Weather API (extended data)", extendedUrl, "GET", undefined, res.status, responseHeaders, responseBody, duration);
      return null;
    }
    
    addApiRequest("Weather API (extended data)", extendedUrl, "GET", undefined, res.status, responseHeaders, responseBody, duration);
    
    const data: any = JSON.parse(responseText);
    
    // Process the Open-Meteo API response
    
    // Open-Meteo API response format
    if (data && data.current_weather && data.daily) {
      const dailyForecast = [];
      for (let i = 0; i < Math.min(7, data.daily.time.length); i++) {
        dailyForecast.push({
          date: data.daily.time[i],
          temperature_max: data.daily.temperature_2m_max[i],
          temperature_min: data.daily.temperature_2m_min[i],
          weathercode: data.daily.weathercode[i],
          sunrise: data.daily.sunrise ? data.daily.sunrise[i] : undefined,
          sunset: data.daily.sunset ? data.daily.sunset[i] : undefined,
        });
      }
      
      // Process today's hourly data (future hours only)
      const hourlyForecast: Array<{ time: string; temperature: number; weathercode: number }> = [];
      if (data.hourly && data.hourly.time && data.hourly.temperature_2m && data.hourly.weathercode) {
        const now = new Date();
        const today = new Date();
        const todayDateStr = today.toISOString().split('T')[0]; // YYYY-MM-DD
        
        for (let i = 0; i < data.hourly.time.length; i++) {
          const hourTime = new Date(data.hourly.time[i]);
          const hourDateStr = hourTime.toISOString().split('T')[0];
          
          // Use only today's data and future hours
          if (hourDateStr === todayDateStr && hourTime > now) {
            hourlyForecast.push({
              time: data.hourly.time[i],
              temperature: data.hourly.temperature_2m[i],
              weathercode: data.hourly.weathercode[i],
            });
          }
        }
      }
      
      // Get current values ONLY from current; do NOT use forecast data
      const currentData = data.current || {};
      const currentTime = data.current_weather?.time || new Date().toISOString();
      
      return {
        current: {
          temperature: data.current_weather.temperature,
          weathercode: data.current_weather.weathercode || 0,
          windspeed: data.current_weather.windspeed || 0,
          winddirection: data.current_weather.winddirection || 0,
          time: currentTime,
          apparent_temperature: currentData.apparent_temperature,
          cloudcover: currentData.cloudcover,
          surface_pressure: currentData.surface_pressure,
          relativehumidity_2m: currentData.relativehumidity_2m,
          dewpoint_2m: currentData.dewpoint_2m,
          precipitation: currentData.precipitation,
          uv_index: currentData.uv_index,
          visibility: currentData.visibility,
        },
        daily: dailyForecast,
        hourly: hourlyForecast,
        timezone: data.timezone || undefined,
        utc_offset_seconds: data.utc_offset_seconds || undefined,
      };
    }
    return null;
  } catch (err) {
    const duration = Date.now() - startTime;
    const error = err instanceof Error ? err : new Error(String(err));
    const errorCode = (err as any)?.code;
    addApiError("Weather API (extended data)", error, extendedUrl, errorCode ? { errorCode } : undefined);
    addApiRequest("Weather API (extended data)", extendedUrl, "GET", undefined, undefined, undefined, undefined, duration);
    console.error("Failed to fetch extended weather:", err);
    return null;
  }
}

/**
 * Create a PNG icon with temperature text using canvas.
 * Based on a working example from another project.
 */
function createTemperatureIcon(text: string): NativeImage {
  // Increase the size for better quality and text visibility
  const size = 32; // Increased canvas size
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");

  // Transparent background (no background is drawn; canvas is transparent by default)
  // Choose the text color based on the state
  let textColor: string;

  if (text === "--" || text === "NA") {
    // Dash or error: light gray
    textColor = "#999999";
  } else {
    // Active temperature: dark gray
    textColor = "#424242";
  }

  // Text settings
  ctx.fillStyle = textColor;
  // If the text is longer than two characters (for example, "-13°"), reduce the font size
  const textLength = text.length;
  let fontSizeMultiplier = isWindows ? 0.5 : 0.75;
  if (textLength > 2) {
    // Reduce the font size for longer text
    fontSizeMultiplier *= 0.75; // Reduce by 25%
  }
  const fontSize = size * fontSizeMultiplier;
  ctx.font = `bold ${fontSize}px Arial`; // Increased font size in proportion to the canvas size
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  
  // Draw the text centered
  const textX = size / 2;
  const textY = size / 2;
  ctx.fillText(text, textX, textY);

  // Convert the canvas to a buffer
  const buffer = canvas.toBuffer("image/png");
  
  // Debug output and save the test file
  console.log(`Created icon for "${text}" (canvas size: ${size}x${size})`);
  
  // // Save a test file for debugging (can be removed later)
  // try {
  //   const testFile = path.join(os.tmpdir(), `weather-icon-${text.replace(/[^a-zA-Z0-9]/g, "_")}.png`);
  //   fs.writeFileSync(testFile, buffer);
  //   console.log(`Test file saved: ${testFile}`);
  // } catch (e) {
  //   console.warn("Could not save the test file:", e);
  // }
  
  return nativeImage.createFromBuffer(buffer);
}

function createBaseIcon(): NativeImage {
  // Base icon shown before the first temperature is loaded
  return createTemperatureIcon("--");
}

/**
 * Convert an OpenWeatherMap weather code to WMO
 * OpenWeatherMap uses its own codes (200–804), which must be converted to WMO codes (0–99)
 */
function convertOpenWeatherMapToWMO(owmCode: number): number {
  // Thunderstorm (Thunderstorm): 200-232 -> WMO 95-99
  if (owmCode >= 200 && owmCode <= 232) {
    if (owmCode >= 230) return 99; // Thunderstorm with heavy hail
    if (owmCode >= 221) return 98; // Thunderstorm with hail
    if (owmCode >= 212) return 97; // Heavy thunderstorm
    return 95; // Thunderstorm
  }
  
  // Drizzle: 300-321 -> WMO 51-55
  if (owmCode >= 300 && owmCode <= 321) {
    if (owmCode >= 320) return 55; // Heavy intensity drizzle
    if (owmCode >= 314) return 54; // Dense intensity drizzle
    if (owmCode >= 311) return 53; // Moderate intensity drizzle
    if (owmCode >= 301) return 52; // Light intensity drizzle
    return 51; // Drizzle
  }
  
  // Rain (Rain): 500-531 -> WMO 61-65
  if (owmCode >= 500 && owmCode <= 531) {
    if (owmCode >= 522) return 65; // Heavy intensity shower rain
    if (owmCode >= 520) return 63; // Shower rain
    if (owmCode >= 511) return 66; // Freezing rain
    if (owmCode >= 502) return 64; // Heavy intensity rain
    if (owmCode === 501) return 63; // Moderate rain
    return 61; // Light rain
  }
  
  // Snow (Snow): 600-622 -> WMO 71-77
  if (owmCode >= 600 && owmCode <= 622) {
    if (owmCode >= 621) return 77; // Heavy snow
    if (owmCode >= 616) return 73; // Sleet
    if (owmCode >= 612) return 72; // Light sleet
    if (owmCode >= 611) return 71; // Sleet
    if (owmCode >= 602) return 75; // Heavy snow
    if (owmCode === 601) return 73; // Snow
    return 71; // Light snow
  }
  
  // Atmospheric conditions (fog, etc.): 701-781 -> WMO 45-48
  if (owmCode >= 701 && owmCode <= 781) {
    if (owmCode >= 771) return 99; // Squall
    if (owmCode >= 762) return 48; // Volcanic ash
    if (owmCode >= 761) return 48; // Sand/dust whirls
    if (owmCode >= 751) return 48; // Sand
    if (owmCode >= 741) return 45; // Fog
    if (owmCode >= 731) return 48; // Sand/dust
    return 45; // Mist
  }
  
  // Clear and cloud cover: 800-804 -> WMO 0-3
  if (owmCode === 800) return 0; // Clear sky
  if (owmCode === 801) return 1; // Few clouds
  if (owmCode === 802) return 2; // Scattered clouds
  if (owmCode === 803) return 2; // Broken clouds
  if (owmCode === 804) return 3; // Overcast clouds
  
  // If the code is not recognized, return 0 (clear) as the default
  console.warn(`Unknown OpenWeatherMap code: ${owmCode}, using WMO 0 (clear)`);
  return 0;
}

/**
 * Get a weather description from weathercode (WMO weather interpretation codes)
 */
function getWeatherDescription(weathercode: number): string {
  if (weathercode === 0) return "Clear";
  if (weathercode >= 1 && weathercode <= 3) return "Cloudy";
  if (weathercode >= 45 && weathercode <= 48) return "Fog";
  if (weathercode >= 51 && weathercode <= 67) return "Rain";
  if (weathercode >= 71 && weathercode <= 77) return "Snow";
  if (weathercode >= 80 && weathercode <= 99) {
    if (weathercode >= 95) return "Thunderstorm";
    if (weathercode >= 85) return "Snow showers";
    return "Rain showers";
  }
  return "Unknown";
}

/**
 * Get a weather emoji from weathercode
 */
function getWeatherEmoji(weathercode: number): string {
  // Mapping of WMO weather interpretation codes to emoji
  if (weathercode === 0) {
    // Clear sky
    return "☀️";
  } else if (weathercode === 1) {
    // Mainly clear
    return "🌤️";
  } else if (weathercode === 2) {
    // Partly cloudy
    return "⛅";
  } else if (weathercode === 3) {
    // Overcast
    return "☁️";
  } else if (weathercode >= 45 && weathercode <= 48) {
    // Fog
    return "🌫️";
  } else if (weathercode >= 51 && weathercode <= 55) {
    // Drizzle
    return "🌦️";
  } else if (weathercode >= 56 && weathercode <= 57) {
    // Freezing drizzle
    return "🌨️";
  } else if (weathercode >= 61 && weathercode <= 65) {
    // Rain
    return "🌧️";
  } else if (weathercode >= 66 && weathercode <= 67) {
    // Freezing rain
    return "🌨️";
  } else if (weathercode >= 71 && weathercode <= 77) {
    // Snow
    return "❄️";
  } else if (weathercode >= 80 && weathercode <= 82) {
    // Rain showers
    return "🌦️";
  } else if (weathercode >= 85 && weathercode <= 86) {
    // Snow showers
    return "🌨️";
  } else if (weathercode >= 95 && weathercode <= 99) {
    // Thunderstorm
    return "⛈️";
  } else {
    // Unknown code
    return "❓";
  }
}

// Emoji icon cache
let emojiIconCache: Map<number, NativeImage> = new Map();
let emojiCacheInitialized = false;

/**
 * Initialize the color emoji cache using BrowserWindow
 * The cache is only used on Linux
 */
async function initializeEmojiCache(): Promise<void> {
  // Use the cache only on Linux
  if (!isLinux) {
    emojiCacheInitialized = true;
    return;
  }
  
  if (emojiCacheInitialized) return;
  
  // Use a larger size for better quality, then scale down
  const renderSize = 64; // Large size for high-quality rendering
  const targetSize = isWindows ? 16 : 32; // Final icon size
  const weatherCodes = [0, 1, 2, 3, 45, 51, 56, 61, 66, 71, 80, 85, 95];
  
  // Create a temporary hidden window to render color emoji
  const tempWindow = new BrowserWindow({
    width: renderSize,
    height: renderSize,
    show: false,
    transparent: true,
    frame: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  for (const code of weatherCodes) {
    const emoji = getWeatherEmoji(code);
    
    // HTML for displaying emoji
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body {
            margin: 0;
            padding: 0;
            width: ${renderSize}px;
            height: ${renderSize}px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: transparent;
            font-size: ${renderSize * 0.75}px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif;
          }
        </style>
      </head>
      <body>${emoji}</body>
      </html>
    `;

    await new Promise<void>((resolve) => {
      tempWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      tempWindow.webContents.once("did-finish-load", () => {
        setTimeout(() => {
          tempWindow.capturePage().then((image) => {
            // Scale the image to the required size for better quality
            const scaledImage = image.resize({
              width: targetSize,
              height: targetSize,
              quality: 'best'
            });
            emojiIconCache.set(code, scaledImage);
            resolve();
          }).catch(() => {
            resolve(); // Skip if it fails
          });
        }, 100); // Increase the delay for Windows
      });
    });
  }
  
  tempWindow.close();
  emojiCacheInitialized = true;
}

/**
 * Create a weather conditions icon from weathercode using color emoji
 */
function createWeatherIcon(weathercode: number): NativeImage {
  const targetSize = 32;
  
  // Check the color emoji cache only on Linux
  if (isLinux && emojiIconCache.has(weathercode)) {
    const cachedImage = emojiIconCache.get(weathercode)!;
    // Make sure the size is correct
    const size = cachedImage.getSize();
    if (size.width === targetSize && size.height === targetSize) {
      return cachedImage;
    }
    // Scale if the size does not match
    return cachedImage.resize({
      width: targetSize,
      height: targetSize,
      quality: 'best'
    });
  }
  
  // Fallback: use a larger canvas for better quality on Windows
  const renderSize = isWindows ? 32 : targetSize; // Render at a larger size on Windows
  const canvas = createCanvas(renderSize, renderSize);
  const ctx = canvas.getContext("2d");
  
  // Try system fonts that support emoji
  const platform = os.platform();
  let fontFamily = "Arial";
  if (platform === "darwin") {
    fontFamily = "Apple Color Emoji";
  } else if (platform === "win32") {
    fontFamily = "Segoe UI Emoji";
  } else {
    fontFamily = "Noto Color Emoji";
  }
  
  // Use a larger font size for better quality
  const fontSize = renderSize * 0.75;
  ctx.font = `bold ${fontSize}px ${fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  
  const emoji = getWeatherEmoji(weathercode);
  
  // Draw the emoji centered
  ctx.fillText(emoji, renderSize / 2, renderSize / 2);

  const buffer = canvas.toBuffer("image/png");
  let image = nativeImage.createFromBuffer(buffer);
  
  // Scale to the required size for Windows
  if (isWindows && renderSize !== targetSize) {
    image = image.resize({
      width: targetSize,
      height: targetSize,
      quality: 'best'
    });
  }
  
  return image;
}

async function updateTrayTemperature() {
  if (!tray || !weatherTray) return;

  const weatherData = await fetchWeatherData();
  const temp = weatherData?.temperature ?? null;
  const weathercode = weatherData?.weathercode ?? 0;
  
  // Full temperature without rounding for the tooltip, menu, and detailed information window
  const fullLabel = temp !== null ? `${temp} °C` : "N/A";
  
  // Update the last successful refresh time when temperature retrieval succeeds
  if (temp !== null) {
    lastUpdateTime = new Date();
  }

  // Short rounded label for the icon so it fits at a small size
  const shortLabel =
    temp !== null ? `${Math.round(temp)}°` : "NA";

  // Update the first icon: draw the temperature as text
  const iconWithTemp = createTemperatureIcon(shortLabel);
  tray.setImage(iconWithTemp);

  // Update the second icon: draw the weather conditions
  const weatherIcon = createWeatherIcon(weathercode);
  weatherTray.setImage(weatherIcon);
  
  // Format the last update time with seconds
  let timeString = "";
  if (lastUpdateTime) {
    const hours = lastUpdateTime.getHours().toString().padStart(2, "0");
    const minutes = lastUpdateTime.getMinutes().toString().padStart(2, "0");
    const seconds = lastUpdateTime.getSeconds().toString().padStart(2, "0");
    timeString = ` (updated: ${hours}:${minutes}:${seconds})`;
  }

  // Hover tooltip for both icons (same text), with full values and no rounding
  const locationString = cityName && countryName ? `${cityName}, ${countryName}\n` : "";
  const weatherDescription = getWeatherDescription(weathercode);
  const tooltipText = `${locationString}Temperature: ${fullLabel}\nWeather: ${weatherDescription}${timeString}`;
  tray.setToolTip(tooltipText);
  weatherTray.setToolTip(tooltipText);

  // Try to display text directly in the tray (fully supported on macOS).
  try {
    tray.setTitle(fullLabel);
  } catch {
    // May be ignored on Linux/Windows.
  }

  // Create menu items for the first icon (temperature), with full values and no rounding
  const menuItems: any[] = [
    {
      label: `Current temperature: ${fullLabel}`,
      enabled: false,
    },
    {
      label: `Weather: ${getWeatherDescription(weathercode)}`,
      enabled: false,
    },
    { type: "separator" },
  ];

  // Add the last update time, if available
  if (lastUpdateTime) {
    const hours = lastUpdateTime.getHours().toString().padStart(2, "0");
    const minutes = lastUpdateTime.getMinutes().toString().padStart(2, "0");
    const seconds = lastUpdateTime.getSeconds().toString().padStart(2, "0");
    menuItems.push({
      label: `Updated: ${hours}:${minutes}:${seconds}`,
      enabled: false,
    });
    menuItems.push({ type: "separator" });
  }

  // Add coordinates, if available
  if (LATITUDE !== null && LONGITUDE !== null) {
    menuItems.push({
      label: `Coordinates: ${LATITUDE.toFixed(4)}, ${LONGITUDE.toFixed(4)}`,
      enabled: false,
    });
    menuItems.push({
      label: `LATITUDE: ${LATITUDE.toFixed(6)}`,
      enabled: false,
    });
    menuItems.push({
      label: `LONGITUDE: ${LONGITUDE.toFixed(6)}`,
      enabled: false,
    });
    menuItems.push({ type: "separator" });
  }

  // Add city and country, if available
  if (cityName && countryName) {
    menuItems.push({
      label: `City: ${cityName}`,
      enabled: false,
    });
    menuItems.push({
      label: `Country: ${countryName}`,
      enabled: false,
    });
    menuItems.push({ type: "separator" });
  }

  // Add actions
  menuItems.push({
    label: "Refresh now",
    click: () => {
      void updateTrayTemperature();
    },
  });
  menuItems.push({ type: "separator" });
  menuItems.push({
    label: "Detailed weather information",
    click: () => {
      void showWeatherDetails();
    },
  });
  menuItems.push({ type: "separator" });
  menuItems.push({
    label: "Settings",
    click: () => {
      showSettings();
    },
  });
  menuItems.push({ type: "separator" });
  menuItems.push({
    label: "How to use",
    click: () => {
      showHelp();
    },
  });
  menuItems.push({ type: "separator" });
  menuItems.push({
    label: `Show recent API requests${apiRequests.length > 0 ? ` (${apiRequests.length})` : ""}`,
    click: () => {
      showApiRequests();
    },
  });
  menuItems.push({ type: "separator" });
  menuItems.push({
    label: `Show API errors${apiErrors.length > 0 ? ` (${apiErrors.length})` : ""}`,
    click: () => {
      showApiErrors();
    },
  });
  menuItems.push({ type: "separator" });
  menuItems.push({
    label: "Quit",
    click: () => {
      app.quit();
    },
  });

  const contextMenu = Menu.buildFromTemplate(menuItems);
  tray.setContextMenu(contextMenu);

  // Create the same menu for the second icon (weather conditions)
  const weatherMenuItems: any[] = [
    {
      label: `Weather: ${getWeatherDescription(weathercode)}`,
      enabled: false,
    },
    {
      label: `Current temperature: ${fullLabel}`,
      enabled: false,
    },
    { type: "separator" },
  ];

  // Add the last update time, if available
  if (lastUpdateTime) {
    const hours = lastUpdateTime.getHours().toString().padStart(2, "0");
    const minutes = lastUpdateTime.getMinutes().toString().padStart(2, "0");
    const seconds = lastUpdateTime.getSeconds().toString().padStart(2, "0");
    weatherMenuItems.push({
      label: `Updated: ${hours}:${minutes}:${seconds}`,
      enabled: false,
    });
    weatherMenuItems.push({ type: "separator" });
  }

  // Add coordinates, if available
  if (LATITUDE !== null && LONGITUDE !== null) {
    weatherMenuItems.push({
      label: `Coordinates: ${LATITUDE.toFixed(4)}, ${LONGITUDE.toFixed(4)}`,
      enabled: false,
    });
    weatherMenuItems.push({ type: "separator" });
  }

  // Add city and country, if available
  if (cityName && countryName) {
    weatherMenuItems.push({
      label: `City: ${cityName}`,
      enabled: false,
    });
    weatherMenuItems.push({
      label: `Country: ${countryName}`,
      enabled: false,
    });
    weatherMenuItems.push({ type: "separator" });
  }

  // Add actions
  weatherMenuItems.push({
    label: "Refresh now",
    click: () => {
      void updateTrayTemperature();
    },
  });
  weatherMenuItems.push({ type: "separator" });
  weatherMenuItems.push({
    label: "Detailed weather information",
    click: () => {
      void showWeatherDetails();
    },
  });
  weatherMenuItems.push({ type: "separator" });
  weatherMenuItems.push({
    label: "Settings",
    click: () => {
      showSettings();
    },
  });
  weatherMenuItems.push({ type: "separator" });
  weatherMenuItems.push({
    label: "How to use",
    click: () => {
      showHelp();
    },
  });
  weatherMenuItems.push({ type: "separator" });
  weatherMenuItems.push({
    label: `Show recent API requests${apiRequests.length > 0 ? ` (${apiRequests.length})` : ""}`,
    click: () => {
      showApiRequests();
    },
  });
  weatherMenuItems.push({ type: "separator" });
  weatherMenuItems.push({
    label: `Show API errors${apiErrors.length > 0 ? ` (${apiErrors.length})` : ""}`,
    click: () => {
      showApiErrors();
    },
  });
  weatherMenuItems.push({ type: "separator" });
  weatherMenuItems.push({
    label: "Quit",
    click: () => {
      app.quit();
    },
  });

  const weatherContextMenu = Menu.buildFromTemplate(weatherMenuItems);
  weatherTray.setContextMenu(weatherContextMenu);
}

async function createTray() {
  // Initialize the location first
  const initialized = await initializeLocation();
  if (!initialized) {
    console.error("Could not initialize the location. The app was not started.");
    app.quit();
    return;
  }

  // Create the first icon (temperature)
  const baseIcon = createBaseIcon();
  tray = new Tray(baseIcon);
  
  // Left-click handler for the first icon
  tray.on('click', () => {
    void showWeatherDetails();
  });

  // Create the second icon (weather conditions)
  const baseWeatherIcon = createWeatherIcon(0); // Initial icon: clear
  weatherTray = new Tray(baseWeatherIcon);
  
  // Left-click handler for the second icon
  weatherTray.on('click', () => {
    void showWeatherDetails();
  });

  void updateTrayTemperature();

  // Refresh at the interval specified in settings
  const updateIntervalMs = UPDATE_INTERVAL_SECONDS * 1000;
  console.log(`Temperature update interval: ${UPDATE_INTERVAL_SECONDS} seconds (${updateIntervalMs} ms)`);
  updateInterval = setInterval(() => {
    void updateTrayTemperature();
  }, updateIntervalMs);
}

// Prevent automatic app shutdown when all windows are closed
// Only the tray is required; windows are optional
app.on("window-all-closed", () => {
  // Keep the app open while the tray exists
  // app.quit() is called only explicitly through the "Quit" menu
});

// Ensure only one app instance can run (if enabled)
if (ALLOW_ONLY_ONE_INSTANCE) {
  const gotTheLock = app.requestSingleInstanceLock();

  if (!gotTheLock) {
    // If another instance is already running, close this one
    app.quit();
  } else {
    // Handle an attempt to launch a second instance
    app.on('second-instance', () => {
      // If the user tries to launch a second instance, show the existing windows
      const windows = [settingsWindow, weatherWindow, requestWindow, errorWindow, helpWindow];
      for (const window of windows) {
        if (window && !window.isDestroyed()) {
          if (window.isMinimized()) window.restore();
          window.show();
          window.focus();
          break; // Show only the first available window
        }
      }
    });

    app.whenReady().then(async () => {
      // Initialize the color emoji cache before creating the tray
      await initializeEmojiCache();
      // Do not create a window; only the tray is needed.
      await createTray();
      if (process.env.NODE_ENV === 'test' && process.env.WEATHER_TEST_OPEN_SETTINGS === '1') showSettings();
    });
  }
} else {
  // If multiple instances are allowed, launch without checking the lock
  app.whenReady().then(async () => {
    // Initialize the color emoji cache before creating the tray
    await initializeEmojiCache();
    // Do not create a window; only the tray is needed.
    await createTray();
    if (process.env.NODE_ENV === 'test' && process.env.WEATHER_TEST_OPEN_SETTINGS === '1') showSettings();
  });
}

app.on("before-quit", () => {
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
  if (weatherTray) {
    weatherTray.destroy();
    weatherTray = null;
  }
});


