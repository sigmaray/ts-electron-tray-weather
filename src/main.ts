import { app, Tray, Menu, nativeImage, NativeImage, dialog, BrowserWindow, shell, ipcMain, Notification, screen } from "electron";
import { createCanvas } from "canvas";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const isMac = os.platform() === "darwin";
const isWindows = os.platform() === "win32";
const isLinux = os.platform() === "linux";

// Константа для управления разрешением только одного экземпляра приложения
const ALLOW_ONLY_ONE_INSTANCE = process.env.ALLOW_ONLY_ONE_INSTANCE !== 'false';

// Интерфейс для настроек
interface Settings {
  city?: string;
  country?: string;
  latitude?: number | null;
  longitude?: number | null;
  updateIntervalInSeconds?: number;
  apiProvider?: 'open-meteo' | 'openweathermap';
  apiKey?: string;
}

// Определяем путь к settings.json файлу (в корне проекта)
// В Electron __dirname может указывать на dist/, поэтому проверяем несколько вариантов
function getSettingsPath(): string {
  // Вариант 1: если запускаем из dist/, то settings.json в родительской директории
  const distPath = path.join(__dirname, "..", "settings.json");
  if (fs.existsSync(distPath)) {
    return distPath;
  }
  
  // Вариант 2: если запускаем из корня проекта
  const rootPath = path.join(process.cwd(), "settings.json");
  if (fs.existsSync(rootPath)) {
    return rootPath;
  }
  
  // Вариант 3: создаём в корне проекта (где находится package.json)
  return rootPath;
}

function loadSettings(): Settings {
  const settingsPath = getSettingsPath();
  
  // Создаём settings.json файл с дефолтными значениями, если его нет
  if (!fs.existsSync(settingsPath)) {
    const defaultSettings: Settings = {
      city: "New York City",
      country: "United States",
      latitude: null,
      longitude: null,
      updateIntervalInSeconds: 60,
      apiProvider: 'open-meteo',
      apiKey: undefined,
    };
    fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 2), "utf8");
    console.log(`Создан файл settings.json с дефолтными значениями: ${settingsPath}`);
    return defaultSettings;
  }
  
  // Загружаем настройки из settings.json
  try {
    const settingsContent = fs.readFileSync(settingsPath, "utf8");
    const settings: Settings = JSON.parse(settingsContent);
    // Устанавливаем значение по умолчанию для updateIntervalInSeconds, если оно отсутствует
    if (settings.updateIntervalInSeconds === undefined || settings.updateIntervalInSeconds === null) {
      settings.updateIntervalInSeconds = 60;
    }
    // Устанавливаем значение по умолчанию для apiProvider, если оно отсутствует
    if (!settings.apiProvider || (settings.apiProvider !== 'open-meteo' && settings.apiProvider !== 'openweathermap')) {
      settings.apiProvider = 'open-meteo';
    }
    console.log(`Загружен файл settings.json: ${settingsPath}`);
    return settings;
  } catch (err) {
    console.error("Ошибка при загрузке settings.json:", err);
    // Возвращаем дефолтные настройки при ошибке
    return {
      city: "New York City",
      country: "United States",
      latitude: null,
      longitude: null,
      updateIntervalInSeconds: 60,
      apiProvider: 'open-meteo',
      apiKey: undefined,
    };
  }
}

// Загружаем настройки
let settings = loadSettings();

// Читаем настройки местоположения из settings.json
// Можно указать ЛИБО координаты (latitude, longitude), ЛИБО город и страну (city, country)
let CITY: string | undefined = settings.city;
let COUNTRY: string | undefined = settings.country;

// Если указаны CITY и COUNTRY, но не LATITUDE и LONGITUDE, координаты будут определены через API
let LATITUDE: number | null = settings.latitude ?? null;
let LONGITUDE: number | null = settings.longitude ?? null;

// Интервал обновления температуры в секундах (по умолчанию 60)
let UPDATE_INTERVAL_SECONDS: number = settings.updateIntervalInSeconds ?? 60;

// API провайдер (по умолчанию open-meteo)
let API_PROVIDER: 'open-meteo' | 'openweathermap' = settings.apiProvider ?? 'open-meteo';

// API ключ (требуется для openweathermap)
let API_KEY: string | undefined = settings.apiKey;

// URL для запроса погоды (генерируется в initializeLocation)
let WEATHER_URL = "";

let tray: Tray | null = null;
let weatherTray: Tray | null = null; // Вторая иконка для погодных условий
let updateInterval: NodeJS.Timeout | null = null;
let lastUpdateTime: Date | null = null;
let cityName: string = "";
let countryName: string = "";

// Массив для хранения последних 20 ошибок API
interface ApiError {
  timestamp: Date;
  api: string; // Название API (weather, geocoding, etc.)
  error: string; // Текст ошибки
  url?: string; // URL запроса (опционально)
  statusCode?: number; // HTTP статус код (404, 403, 500 и т.д.)
  errorCode?: string; // Код ошибки Node.js (ENOTFOUND, ECONNREFUSED и т.д.)
  details?: string; // Дополнительные детали
}

const apiErrors: ApiError[] = [];
const MAX_ERRORS = 20;

// Массив для хранения последних 20 API-запросов
interface ApiRequest {
  timestamp: Date;
  api: string; // Название API (weather, geocoding, etc.)
  url: string; // URL запроса
  method: string; // HTTP метод (GET, POST, etc.)
  requestHeaders?: Record<string, string>; // Заголовки запроса
  responseStatus?: number; // HTTP статус код ответа
  responseHeaders?: Record<string, string>; // Заголовки ответа
  responseBody?: string; // Тело ответа (JSON строка)
  duration?: number; // Длительность запроса в мс
}

const apiRequests: ApiRequest[] = [];
const MAX_REQUESTS = 20;

// Ссылки на открытые окна (для предотвращения дублирования)
let settingsWindow: BrowserWindow | null = null;
let weatherWindow: BrowserWindow | null = null;
let requestWindow: BrowserWindow | null = null;
let errorWindow: BrowserWindow | null = null;
let helpWindow: BrowserWindow | null = null;

/**
 * Извлекает детальную информацию из ошибки
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

    // Проверяем наличие кода ошибки Node.js (ENOTFOUND, ECONNREFUSED и т.д.)
    if ((err as any).code) {
      errorCode = (err as any).code;
    }

    // Проверяем наличие HTTP статус кода
    const httpStatusMatch = message.match(/HTTP error (\d+)/i) || message.match(/status (\d+)/i);
    if (httpStatusMatch) {
      statusCode = parseInt(httpStatusMatch[1], 10);
    }

    // Извлекаем дополнительные детали из stack trace или других свойств
    if (err.stack) {
      const stackLines = err.stack.split('\n');
      if (stackLines.length > 1) {
        details = stackLines.slice(1, 3).join('\n').trim(); // Первые 2 строки stack trace после сообщения
      }
    }

    // Если есть свойство cause, добавляем его в детали
    if ((err as any).cause) {
      const cause = (err as any).cause;
      if (details) {
        details += `\nПричина: ${cause instanceof Error ? cause.message : String(cause)}`;
      } else {
        details = `Причина: ${cause instanceof Error ? cause.message : String(cause)}`;
      }
    }

    return { message, errorCode, statusCode, details };
  }

  return { message: String(err) };
}

/**
 * Добавляет ошибку в список последних ошибок с детальной информацией
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
  
  // Ограничиваем количество ошибок до MAX_ERRORS
  if (apiErrors.length > MAX_ERRORS) {
    apiErrors.shift(); // Удаляем самую старую ошибку
  }
  
  const errorInfo = [
    errorDetails.message,
    errorDetails.errorCode && `Код: ${errorDetails.errorCode}`,
    errorDetails.statusCode && `HTTP: ${errorDetails.statusCode}`,
  ].filter(Boolean).join(', ');
  
  console.error(`[${api}] Ошибка добавлена в историю:`, errorInfo);
}

/**
 * Добавляет запрос в историю последних запросов
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
  
  // Ограничиваем количество запросов до MAX_REQUESTS
  if (apiRequests.length > MAX_REQUESTS) {
    apiRequests.shift(); // Удаляем самый старый запрос
  }
  
  console.log(`[${api}] Запрос добавлен в историю: ${method} ${url} (${responseStatus || 'N/A'})`);
}

/**
 * Экранирует HTML-специальные символы
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
 * Проверяет, является ли строка URL
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
 * Сохраняет настройки в файл settings.json
 */
function saveSettings(newSettings: Settings): boolean {
  try {
    const settingsPath = getSettingsPath();
    fs.writeFileSync(settingsPath, JSON.stringify(newSettings, null, 2), "utf8");
    console.log(`Настройки сохранены в файл: ${settingsPath}`);
    return true;
  } catch (err) {
    console.error("Ошибка при сохранении settings.json:", err);
    return false;
  }
}

/**
 * Применяет новые настройки и переинициализирует приложение
 */
async function applySettings(newSettings: Settings): Promise<boolean> {
  // Сохраняем текущие настройки для возможного отката
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

  // Объединяем с текущими настройками (на случай частичного обновления)
  const mergedSettings: Settings = {
    ...settings,
    ...newSettings,
  };

  // Обновляем глобальные переменные
  // Явно устанавливаем null/undefined, чтобы очистить старые значения
  CITY = mergedSettings.city ?? undefined;
  COUNTRY = mergedSettings.country ?? undefined;
  LATITUDE = mergedSettings.latitude ?? null;
  LONGITUDE = mergedSettings.longitude ?? null;
  UPDATE_INTERVAL_SECONDS = mergedSettings.updateIntervalInSeconds ?? 60;
  API_PROVIDER = mergedSettings.apiProvider ?? 'open-meteo';
  API_KEY = mergedSettings.apiKey;
  settings = mergedSettings;
  
  // Очищаем WEATHER_URL при изменении настроек, чтобы он пересоздался в initializeLocation
  WEATHER_URL = "";
  
  // Если переключились с города/страны на координаты, очищаем старые названия
  // чтобы они обновились по новым координатам
  if (previousCity && previousCountry && (CITY === undefined || COUNTRY === undefined) && 
      LATITUDE !== null && LONGITUDE !== null) {
    cityName = "";
    countryName = "";
  }

  // Сохраняем в файл
  if (!saveSettings(mergedSettings)) {
    // Откатываем изменения при ошибке сохранения
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

  // Переинициализируем местоположение
  const initialized = await initializeLocation();
  if (!initialized) {
    // Откатываем изменения при ошибке инициализации
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
    // Восстанавливаем файл с предыдущими настройками
    saveSettings(previousSettings);
    // НЕ переинициализируем местоположение - оставляем текущее состояние
    // Приложение продолжит работать с предыдущими настройками
    console.log("Откат изменений выполнен. Приложение продолжает работать с предыдущими настройками.");
    return false;
  }

  // Обновляем интервал обновления
  if (updateInterval) {
    clearInterval(updateInterval);
  }
  const updateIntervalMs = UPDATE_INTERVAL_SECONDS * 1000;
  console.log(`Интервал обновления температуры обновлён: ${UPDATE_INTERVAL_SECONDS} секунд (${updateIntervalMs} мс)`);
  updateInterval = setInterval(() => {
    void updateTrayTemperature();
  }, updateIntervalMs);

  // Обновляем температуру сразу
  void updateTrayTemperature();

  return true;
}

/**
 * Валидирует настройки
 */
function validateSettings(newSettings: Partial<Settings>): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Валидация updateIntervalInSeconds
  if (newSettings.updateIntervalInSeconds !== undefined && newSettings.updateIntervalInSeconds !== null) {
    if (typeof newSettings.updateIntervalInSeconds !== "number" || isNaN(newSettings.updateIntervalInSeconds)) {
      errors.push("Интервал обновления должен быть числом");
    } else if (newSettings.updateIntervalInSeconds < 1) {
      errors.push("Интервал обновления должен быть не менее 1 секунды");
    }
  }

  // Валидация latitude
  if (newSettings.latitude !== undefined && newSettings.latitude !== null) {
    if (typeof newSettings.latitude !== "number" || isNaN(newSettings.latitude)) {
      errors.push("Широта должна быть числом");
    } else if (newSettings.latitude < -90 || newSettings.latitude > 90) {
      errors.push("Широта должна быть в диапазоне от -90 до 90");
    }
  }

  // Валидация longitude
  if (newSettings.longitude !== undefined && newSettings.longitude !== null) {
    if (typeof newSettings.longitude !== "number" || isNaN(newSettings.longitude)) {
      errors.push("Долгота должна быть числом");
    } else if (newSettings.longitude < -180 || newSettings.longitude > 180) {
      errors.push("Долгота должна быть в диапазоне от -180 до 180");
    }
  }

  // Валидация city
  if (newSettings.city !== undefined && newSettings.city !== null && newSettings.city.trim() === "") {
    errors.push("Город не может быть пустой строкой (используйте null для очистки)");
  }

  // Валидация country
  if (newSettings.country !== undefined && newSettings.country !== null && newSettings.country.trim() === "") {
    errors.push("Страна не может быть пустой строкой (используйте null для очистки)");
  }

  // Валидация apiProvider
  if (newSettings.apiProvider !== undefined) {
    if (newSettings.apiProvider !== 'open-meteo' && newSettings.apiProvider !== 'openweathermap') {
      errors.push("API провайдер должен быть 'open-meteo' или 'openweathermap'");
    }
  }

  // Валидация apiKey: обязателен для openweathermap
  const mergedForValidation: Settings = {
    ...settings,
    ...newSettings,
  };
  const finalApiProvider = mergedForValidation.apiProvider ?? 'open-meteo';
  if (finalApiProvider === 'openweathermap') {
    const apiKey = mergedForValidation.apiKey;
    if (!apiKey || apiKey.trim() === '') {
      errors.push("API ключ обязателен при использовании OpenWeatherMap API");
    }
  }

  // Проверка: должны быть указаны либо координаты, либо город и страна

  // Проверяем наличие координат (хотя бы одна заполнена)
  const hasAnyCoordinate = (mergedForValidation.latitude !== null && mergedForValidation.latitude !== undefined) ||
                           (mergedForValidation.longitude !== null && mergedForValidation.longitude !== undefined);
  const hasBothCoordinates = mergedForValidation.latitude !== null && mergedForValidation.latitude !== undefined &&
                             mergedForValidation.longitude !== null && mergedForValidation.longitude !== undefined;
  
  // Проверяем наличие города/страны (хотя бы одно заполнено)
  const hasAnyCityCountry = (mergedForValidation.city && mergedForValidation.city.trim() !== "") ||
                            (mergedForValidation.country && mergedForValidation.country.trim() !== "");
  const hasBothCityCountry = mergedForValidation.city && mergedForValidation.city.trim() !== "" &&
                             mergedForValidation.country && mergedForValidation.country.trim() !== "";

  // Проверяем, что не заполнены одновременно оба варианта (даже частично)
  if (hasAnyCoordinate && hasAnyCityCountry) {
    errors.push("Нельзя указывать одновременно и город/страну, и координаты. Выберите один вариант.");
  }

  // Проверяем, что заполнено хотя бы одно полностью
  if (!hasBothCoordinates && !hasBothCityCountry) {
    errors.push("Необходимо указать либо обе координаты (широта и долгота), либо город и страну");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Получает координаты для центрирования окна на основном мониторе
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
 * Показывает диалог настроек для редактирования settings.json
 */
function showSettings(): void {
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Настройки</title>
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
        <h1>⚙️ Настройки</h1>
        
        <div class="info-box">
          <h3>ℹ️ Важная информация</h3>
          <p><strong>Необходимо указать один из вариантов:</strong></p>
          <ul>
            <li><strong>Город и Страна</strong> — координаты будут определены автоматически</li>
            <li><strong>Широта и Долгота</strong> — координаты указываются вручную</li>
          </ul>
          <p style="margin-top: 12px;">
            <strong>Файл настроек:</strong> <code>${getSettingsPath()}</code>
          </p>
        </div>
        
        <div id="validationErrors" class="validation-errors">
          <h3>Ошибки валидации:</h3>
          <ul id="validationErrorsList"></ul>
        </div>

        <form id="settingsForm">
          <div class="form-group">
            <label>
              Город
              <span class="label-hint">(например: "Minsk" или оставьте пустым)</span>
            </label>
            <input type="text" id="city" placeholder="Введите название города">
            <div class="error-message" id="cityError"></div>
          </div>

          <div class="form-group">
            <label>
              Страна
              <span class="label-hint">(например: "Belarus" или оставьте пустым)</span>
            </label>
            <input type="text" id="country" placeholder="Введите название страны">
            <div class="error-message" id="countryError"></div>
          </div>

          <div class="quick-links">
            <h3>📍 Быстрый выбор города:</h3>
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
              Широта (Latitude)
              <span class="label-hint">(от -90 до 90, или оставьте пустым)</span>
            </label>
            <input type="number" id="latitude" step="any" placeholder="Например: 53.9045">
            <div class="error-message" id="latitudeError"></div>
          </div>

          <div class="form-group">
            <label>
              Долгота (Longitude)
              <span class="label-hint">(от -180 до 180, или оставьте пустым)</span>
            </label>
            <input type="number" id="longitude" step="any" placeholder="Например: 27.5615">
            <div class="error-message" id="longitudeError"></div>
          </div>

          <div class="form-group">
            <label>
              Интервал обновления (секунды)
              <span class="label-hint">(минимум 1 секунда)</span>
            </label>
            <input type="number" id="updateInterval" min="1" step="1" placeholder="60">
            <div class="error-message" id="updateIntervalError"></div>
          </div>

          <div class="form-group">
            <label>
              API Провайдер
              <span class="label-hint">(выберите источник данных о погоде)</span>
            </label>
            <select id="apiProvider" style="width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px;">
              <option value="open-meteo">Open-Meteo (бесплатно, без ключа)</option>
              <option value="openweathermap">OpenWeatherMap (требуется API ключ)</option>
            </select>
            <div class="error-message" id="apiProviderError"></div>
          </div>

          <div class="form-group" id="apiKeyGroup" style="display: none;">
            <label>
              API Ключ (OpenWeatherMap)
              <span class="label-hint">(обязательно для OpenWeatherMap)</span>
            </label>
            <input type="text" id="apiKey" placeholder="Введите ваш API ключ от OpenWeatherMap">
            <div class="error-message" id="apiKeyError"></div>
            <p style="margin-top: 8px; font-size: 12px; color: #757575;">
              Получить API ключ можно на <a href="https://openweathermap.org/api" target="_blank" style="color: #1976d2;">openweathermap.org/api</a>
            </p>
          </div>

          <div class="buttons">
            <button type="button" class="btn-cancel" id="cancelBtn">Отмена</button>
            <button type="submit" class="btn-save" id="saveBtn">Сохранить</button>
          </div>
        </form>
      </div>

      <script>
        const { ipcRenderer } = require('electron');
        
        // Загружаем текущие настройки
        const currentSettings = ${JSON.stringify(settings)};
        
        // Заполняем форму текущими значениями
        document.getElementById('city').value = currentSettings.city || '';
        document.getElementById('country').value = currentSettings.country || '';
        document.getElementById('latitude').value = currentSettings.latitude !== null && currentSettings.latitude !== undefined ? currentSettings.latitude : '';
        document.getElementById('longitude').value = currentSettings.longitude !== null && currentSettings.longitude !== undefined ? currentSettings.longitude : '';
        document.getElementById('updateInterval').value = currentSettings.updateIntervalInSeconds || 60;
        document.getElementById('apiProvider').value = currentSettings.apiProvider || 'open-meteo';
        document.getElementById('apiKey').value = currentSettings.apiKey || '';
        
        // Показываем/скрываем поле API ключа в зависимости от выбранного провайдера
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

        // Проверяем при загрузке: если заполнены оба варианта, очищаем координаты (приоритет у города/страны)
        const hasCityCountry = (currentSettings.city && currentSettings.city.trim() !== '') &&
                               (currentSettings.country && currentSettings.country.trim() !== '');
        const hasAnyCoordinate = (currentSettings.latitude !== null && currentSettings.latitude !== undefined) ||
                                (currentSettings.longitude !== null && currentSettings.longitude !== undefined);
        
        if (hasCityCountry && hasAnyCoordinate) {
          // Очищаем координаты, если заполнены город и страна
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

          // Собираем данные формы
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

          // Валидация на стороне клиента (базовая)
          const validation = {
            valid: true,
            errors: []
          };

          if (newSettings.updateIntervalInSeconds < 1 || isNaN(newSettings.updateIntervalInSeconds)) {
            validation.valid = false;
            validation.errors.push('Интервал обновления должен быть не менее 1 секунды');
            showFieldError('updateInterval', 'Интервал должен быть не менее 1 секунды');
          }

          // Валидация API провайдера и ключа
          if (newSettings.apiProvider !== 'open-meteo' && newSettings.apiProvider !== 'openweathermap') {
            validation.valid = false;
            validation.errors.push('Неверный API провайдер');
            showFieldError('apiProvider', 'Выберите корректный API провайдер');
          }

          if (newSettings.apiProvider === 'openweathermap' && (!newSettings.apiKey || newSettings.apiKey.trim() === '')) {
            validation.valid = false;
            validation.errors.push('API ключ обязателен при использовании OpenWeatherMap');
            showFieldError('apiKey', 'API ключ обязателен для OpenWeatherMap');
          }

          if (newSettings.latitude !== null && (isNaN(newSettings.latitude) || newSettings.latitude < -90 || newSettings.latitude > 90)) {
            validation.valid = false;
            validation.errors.push('Широта должна быть числом от -90 до 90');
            showFieldError('latitude', 'Широта должна быть от -90 до 90');
          }

          if (newSettings.longitude !== null && (isNaN(newSettings.longitude) || newSettings.longitude < -180 || newSettings.longitude > 180)) {
            validation.valid = false;
            validation.errors.push('Долгота должна быть числом от -180 до 180');
            showFieldError('longitude', 'Долгота должна быть от -180 до 180');
          }

          // Проверяем наличие координат (хотя бы одна заполнена)
          const hasAnyCoordinate = (newSettings.latitude !== null && newSettings.latitude !== undefined) ||
                                   (newSettings.longitude !== null && newSettings.longitude !== undefined);
          const hasBothCoordinates = newSettings.latitude !== null && newSettings.latitude !== undefined &&
                                     newSettings.longitude !== null && newSettings.longitude !== undefined;
          
          // Проверяем наличие города/страны (хотя бы одно заполнено)
          const hasAnyCityCountry = (newSettings.city && newSettings.city.trim() !== '') ||
                                    (newSettings.country && newSettings.country.trim() !== '');
          const hasBothCityCountry = newSettings.city && newSettings.city.trim() !== '' &&
                                     newSettings.country && newSettings.country.trim() !== '';

          // Проверяем, что не заполнены одновременно оба варианта (даже частично)
          if (hasAnyCoordinate && hasAnyCityCountry) {
            validation.valid = false;
            validation.errors.push('Нельзя указывать одновременно и город/страну, и координаты. Выберите один вариант.');
          }

          // Проверяем, что заполнено хотя бы одно полностью
          if (!hasBothCoordinates && !hasBothCityCountry) {
            validation.valid = false;
            validation.errors.push('Необходимо указать либо обе координаты (широта и долгота), либо город и страну');
          }

          if (!validation.valid) {
            showValidationErrors(validation.errors);
            return;
          }

          // Отправляем настройки в главный процесс для валидации и сохранения
          ipcRenderer.send('save-settings', newSettings);
        });

        document.getElementById('cancelBtn').addEventListener('click', () => {
          window.close();
        });

        // Логика взаимного исключения: при заполнении города/страны очищаем координаты
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

        // При вводе в поля города или страны - очищаем координаты
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

        // При вводе в поля координат - очищаем город и страну
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

        // Обработка быстрых ссылок на города
        document.querySelectorAll('.quick-link').forEach(link => {
          link.addEventListener('click', (e) => {
            e.preventDefault();
            const city = link.getAttribute('data-city');
            const country = link.getAttribute('data-country');
            if (city && country) {
              document.getElementById('city').value = city;
              document.getElementById('country').value = country;
              // Очищаем координаты при выборе города
              clearCoordinates();
              // Очищаем ошибки
              clearErrors();
            }
          });
        });

        // Функция для показа toast-уведомления
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
            }, 300); // Закрываем окно после анимации исчезновения
          }, duration);
        }

        // Обработка ответов от главного процесса
        // Окно закрывается автоматически после успешного сохранения,
        // уведомление показывается через системное уведомление

        ipcRenderer.on('settings-error', (event, errors) => {
          showValidationErrors(errors);
        });
      </script>
    </body>
    </html>
  `;

  // Проверяем, не открыто ли окно уже
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) {
      settingsWindow.restore();
    }
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  // Создаём окно для настроек
  const windowSize = { width: 650, height: 700 };
  const windowPosition = getWindowPositionOnPrimaryDisplay(windowSize.width, windowSize.height);
  settingsWindow = new BrowserWindow({
    width: windowSize.width,
    height: windowSize.height,
    x: windowPosition.x,
    y: windowPosition.y,
    title: "Настройки — Tray Weather",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    resizable: true,
    modal: false,
  });

  // Загружаем HTML-контент
  settingsWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  // Обработка сохранения настроек
  // Удаляем предыдущие обработчики для этого окна, если они есть
  const handler = async (event: any, newSettings: Partial<Settings>) => {
    // Проверяем, что событие пришло от нашего окна
    if (event.sender !== settingsWindow!.webContents) {
      return;
    }

    // Валидация на стороне сервера
    const validation = validateSettings(newSettings);
    
    if (!validation.valid) {
      event.sender.send('settings-error', validation.errors);
      return;
    }

    // Применяем настройки
    const success = await applySettings(newSettings as Settings);
    
    if (success) {
      // Удаляем обработчик после успешного сохранения
      ipcMain.removeListener('save-settings', handler);
      // Закрываем окно настроек
      settingsWindow!.close();
      // Показываем системное уведомление после закрытия окна
      setTimeout(() => {
        if (Notification.isSupported()) {
          const notification = new Notification({
            title: 'Настройки сохранены',
            body: 'Настройки успешно сохранены и применены.',
            silent: false,
          });
          notification.show();
        }
      }, 100); // Небольшая задержка для корректного закрытия окна
    } else {
      // При ошибке показываем сообщение, но не закрываем окно настроек
      // чтобы пользователь мог исправить данные
      // Приложение продолжает работать с предыдущими настройками
      const errorMessage = 'Не удалось применить настройки. Проверьте правильность введённых данных (координаты или город и страна). Приложение продолжит работать с предыдущими настройками.';
      event.sender.send('settings-error', [errorMessage]);
      // Показываем диалог асинхронно, чтобы не блокировать выполнение
      dialog.showMessageBox(settingsWindow!, {
        type: 'error',
        title: 'Ошибка применения настроек',
        message: errorMessage,
        buttons: ['OK'],
      }).catch((err) => {
        console.error('Ошибка при показе диалога:', err);
      });
    }
  };

  ipcMain.on('save-settings', handler);

  // Обработчик закрытия окна: очищаем ссылку и удаляем IPC обработчик
  settingsWindow.on('closed', () => {
    ipcMain.removeListener('save-settings', handler);
    settingsWindow = null;
  });
}

/**
 * Показывает окно со справочной информацией о приложении
 */
function showHelp(): void {
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Как пользоваться</title>
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
        /* Стили для скроллбара */
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
        <h1>🌡️ Tray Weather — Справочная информация</h1>
        <p>Приложение для отображения текущей температуры в системном трее</p>
      </div>
      <div class="content">
        <div class="section">
          <h2>📋 Возможности</h2>
          <ul class="feature-list">
            <li><strong>Температура в иконке трея</strong> — отображается прямо на иконке в виде текста (например, <code>5°</code>, <code>-3°</code>)</li>
            <li><strong>Автоматическое обновление</strong> — температура обновляется каждую минуту</li>
            <li><strong>Гибкая настройка местоположения</strong> — можно указать либо координаты, либо город и страну</li>
            <li><strong>Время последнего обновления</strong> — показывается в tooltip и меню с точностью до секунды</li>
            <li><strong>Информация о местоположении</strong> — координаты, город и страна в контекстном меню</li>
            <li><strong>История ошибок API</strong> — сохраняются последние 20 ошибок для отладки</li>
          </ul>
        </div>

        <div class="section">
          <h2>📍 Настройка местоположения</h2>
          <p>Настройки хранятся в файле <code>settings.json</code> в корне проекта. При первом запуске файл создаётся автоматически с дефолтными значениями.</p>
          
          <div style="background: #fff3cd; border: 1px solid #ffc107; border-radius: 4px; padding: 12px; margin-bottom: 16px;">
            <p style="margin: 0; color: #856404; font-weight: 500;"><strong>⚠️ Важно:</strong> По умолчанию температура показывается для <strong>New York City, United States</strong>. Чтобы показывалась температура для вашей актуальной локации, необходимо изменить настройки через диалог "Настройки" или отредактировать файл <code>settings.json</code> вручную.</p>
          </div>
          
          <h3>⚙️ Диалог "Настройки" (рекомендуется)</h3>
          <p>Вместо ручного редактирования файла <code>settings.json</code> можно использовать удобный диалог настроек:</p>
          <ol>
            <li>Кликните правой кнопкой мыши на иконку в трее</li>
            <li>Выберите пункт <strong>"Настройки"</strong></li>
            <li>В открывшемся окне заполните необходимые поля</li>
            <li>Нажмите кнопку <strong>"Сохранить"</strong></li>
          </ol>
          <p>Диалог автоматически проверит корректность введённых данных и применит настройки. Приложение продолжит работать с новыми настройками без перезапуска.</p>
          
          <h3>📝 Ручное редактирование файла settings.json</h3>
          <p>Альтернативный способ — отредактировать файл <code>settings.json</code> вручную. Необходимо указать один из вариантов:</p>
          
          <h4>Вариант 1: Указать город и страну</h4>
          <p>Отредактируйте файл <code>settings.json</code>:</p>
          <pre>{
  "city": "Minsk",
  "country": "Belarus",
  "latitude": null,
  "longitude": null,
  "updateIntervalInSeconds": 60
}</pre>
          <p>Координаты будут определены автоматически через Geocoding API.</p>

          <h4>Вариант 2: Указать координаты напрямую</h4>
          <p>Отредактируйте файл <code>settings.json</code>:</p>
          <pre>{
  "city": null,
  "country": null,
  "latitude": 55.7558,
  "longitude": 37.6173,
  "updateIntervalInSeconds": 60
}</pre>
          <p>Название города и страны будут определены автоматически по координатам.</p>
        </div>

        <div class="section">
          <h2>💡 Отображение информации</h2>
          
          <h3>Иконка в трее</h3>
          <p>Температура отображается <span class="highlight">прямо на иконке</span> в виде текста. Иконка обновляется каждую минуту.</p>

          <h3>Tooltip (при наведении)</h3>
          <p>Показывает:</p>
          <ul>
            <li>Название города и страны (если доступно)</li>
            <li>Текущую температуру</li>
            <li>Время последнего успешного обновления с секундами</li>
          </ul>
          <p>Пример: <code>Нью-Йорк, США\nТемпература: 0.2 °C (обновлено: 14:35:42)</code></p>

          <h3>Контекстное меню (правый клик)</h3>
          <p>Содержит:</p>
          <ul>
            <li>Текущую температуру</li>
            <li>Время последнего обновления</li>
            <li>Координаты (LATITUDE и LONGITUDE)</li>
            <li>Город и страну (если доступны)</li>
            <li>Пункт <strong>"Обновить сейчас"</strong> для ручного обновления</li>
            <li>Пункт <strong>"Показать ошибки API (N)"</strong> для просмотра истории ошибок</li>
            <li>Пункт <strong>"Выйти"</strong></li>
          </ul>
        </div>

        <div class="section">
          <h2>🐛 История ошибок API</h2>
          <p>Приложение сохраняет последние 20 ошибок взаимодействия с API. Для просмотра:</p>
          <ol>
            <li>Кликните правой кнопкой мыши на иконку в трее</li>
            <li>Выберите пункт <strong>"Показать ошибки API (N)"</strong></li>
            <li>Откроется окно с подробной информацией о каждой ошибке:
              <ul>
                <li>Время возникновения</li>
                <li>Название API</li>
                <li>Текст ошибки</li>
                <li>URL запроса (если доступен, кликабельный)</li>
              </ul>
            </li>
          </ol>
        </div>

        <div class="section">
          <h2>🔧 Технические детали</h2>
          <ul>
            <li><strong>Язык:</strong> TypeScript</li>
            <li><strong>Фреймворк:</strong> Electron</li>
            <li><strong>API погоды:</strong> <a href="https://api.open-meteo.com" class="url-link">Open-Meteo</a> (бесплатно, без ключа)</li>
            <li><strong>API геокодирования:</strong> <a href="https://geocoding-api.open-meteo.com" class="url-link">Open-Meteo Geocoding</a></li>
            <li><strong>Создание иконок:</strong> Canvas (для отрисовки текста температуры)</li>
            <li><strong>Конфигурация:</strong> <code>settings.json</code> файл</li>
          </ul>
        </div>
      </div>
    </body>
    </html>
  `;

  // Проверяем, не открыто ли окно уже
  if (helpWindow && !helpWindow.isDestroyed()) {
    if (helpWindow.isMinimized()) {
      helpWindow.restore();
    }
    helpWindow.show();
    helpWindow.focus();
    return;
  }

  // Создаём окно для отображения справки
  const windowSize = { width: 700, height: 700 };
  const windowPosition = getWindowPositionOnPrimaryDisplay(windowSize.width, windowSize.height);
  helpWindow = new BrowserWindow({
    width: windowSize.width,
    height: windowSize.height,
    x: windowPosition.x,
    y: windowPosition.y,
    title: "Как пользоваться — Tray Weather",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  // Очищаем ссылку при закрытии окна
  helpWindow.on('closed', () => {
    helpWindow = null;
  });

  // Загружаем HTML-контент
  helpWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  // Обработка кликов по ссылкам через webContents
  helpWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Обработка навигации (если пользователь кликнет на ссылку)
  helpWindow.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    shell.openExternal(url);
  });
}

/**
 * Показывает окно с подробной информацией о погоде и прогнозом
 */
async function showWeatherDetails(): Promise<void> {
  // Проверяем, не открыто ли окно уже - если открыто, закрываем его
  if (weatherWindow && !weatherWindow.isDestroyed()) {
    weatherWindow.close();
    return;
  }

  const weatherData = await fetchExtendedWeatherData();
  
  if (!weatherData) {
    dialog.showMessageBox({
      type: "error",
      title: "Ошибка",
      message: "Не удалось загрузить данные о погоде",
      detail: "Попробуйте обновить данные позже.",
    });
    return;
  }

  const locationString = cityName && countryName ? `${cityName}, ${countryName}` : 
                        (LATITUDE !== null && LONGITUDE !== null ? `${LATITUDE.toFixed(4)}, ${LONGITUDE.toFixed(4)}` : "Неизвестно");
  
  // Вспомогательные функции для форматирования
  const getWindDirection = (degrees: number): string => {
    const directions = ["С", "СВ", "В", "ЮВ", "Ю", "ЮЗ", "З", "СЗ"];
    const index = Math.round(degrees / 45) % 8;
    return directions[index];
  };
  
  const getWindDescription = (speed: number): string => {
    if (speed < 0.5) return "штиль";
    if (speed < 1.6) return "легкий ветерок";
    if (speed < 3.4) return "легкий ветер";
    if (speed < 5.5) return "слабый ветер";
    if (speed < 8.0) return "умеренный ветер";
    if (speed < 10.8) return "свежий ветер";
    if (speed < 13.9) return "сильный ветер";
    if (speed < 17.2) return "крепкий ветер";
    if (speed < 20.8) return "очень крепкий ветер";
    if (speed < 24.5) return "шторм";
    if (speed < 28.5) return "сильный шторм";
    if (speed < 32.7) return "жестокий шторм";
    return "ураган";
  };
  
  const getUVDescription = (uv: number): string => {
    if (uv < 3) return "Низкий";
    if (uv < 6) return "Умеренный";
    if (uv < 8) return "Высокий";
    if (uv < 11) return "Очень высокий";
    return "Экстремальный";
  };
  
  const getComfortLevel = (dewpoint: number, humidity?: number): string => {
    if (dewpoint < 10) return "Сухо";
    if (dewpoint < 16) return "Комфортно";
    if (dewpoint < 18) return "Умеренно";
    if (dewpoint < 21) return "Влажно";
    return "Очень влажно";
  };
  
  const formatTime = (timeStr: string): string => {
    // Показываем время в том же формате, в котором оно пришло от API
    // Добавляем информацию о таймзоне и UTC offset
    if (weatherData.timezone !== undefined) {
      // Для OpenWeatherMap timezone - это число (offset в секундах)
      // Для Open-Meteo timezone - это строка (название таймзоны)
      let timezoneDisplay = "";
      let utcOffset = "";
      
      if (typeof weatherData.timezone === "number") {
        // OpenWeatherMap: timezone - это offset в секундах
        const offsetSeconds = weatherData.timezone;
        const hours = Math.floor(Math.abs(offsetSeconds) / 3600);
        const minutes = Math.floor((Math.abs(offsetSeconds) % 3600) / 60);
        const sign = offsetSeconds >= 0 ? "+" : "-";
        utcOffset = `UTC${sign}${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
        timezoneDisplay = utcOffset;
      } else if (typeof weatherData.timezone === "string") {
        // Open-Meteo: timezone - это название таймзоны
        timezoneDisplay = weatherData.timezone;
        if (weatherData.utc_offset_seconds !== undefined) {
          const hours = Math.floor(Math.abs(weatherData.utc_offset_seconds) / 3600);
          const minutes = Math.floor((Math.abs(weatherData.utc_offset_seconds) % 3600) / 60);
          const sign = weatherData.utc_offset_seconds >= 0 ? "+" : "-";
          utcOffset = `UTC${sign}${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
        }
      }
      
      return `${timeStr} (${timezoneDisplay}${utcOffset && typeof weatherData.timezone === "string" ? `, ${utcOffset}` : ""})`;
    }
    
    return timeStr;
  };
  
  const calculateDaylight = (sunrise: string, sunset: string): string => {
    const rise = new Date(sunrise);
    const set = new Date(sunset);
    const diff = set.getTime() - rise.getTime();
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    return `${hours}:${minutes.toString().padStart(2, "0")}`;
  };
  
  // Показываем время в том же формате, в котором оно пришло от API
  const timeStr = weatherData.current.time;
  
  // Форматируем информацию о часовом поясе и UTC offset
  let timezoneInfo = "";
  if (weatherData.timezone !== undefined) {
    // Для OpenWeatherMap timezone - это число (offset в секундах)
    // Для Open-Meteo timezone - это строка (название таймзоны)
    let timezoneDisplay = "";
    let utcOffset = "";
    
    if (typeof weatherData.timezone === "number") {
      // OpenWeatherMap: timezone - это offset в секундах
      const offsetSeconds = weatherData.timezone;
      const hours = Math.floor(Math.abs(offsetSeconds) / 3600);
      const minutes = Math.floor((Math.abs(offsetSeconds) % 3600) / 60);
      const sign = offsetSeconds >= 0 ? "+" : "-";
      utcOffset = `UTC${sign}${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
      timezoneDisplay = utcOffset;
    } else if (typeof weatherData.timezone === "string") {
      // Open-Meteo: timezone - это название таймзоны
      timezoneDisplay = weatherData.timezone;
      if (weatherData.utc_offset_seconds !== undefined) {
        const hours = Math.floor(Math.abs(weatherData.utc_offset_seconds) / 3600);
        const minutes = Math.floor((Math.abs(weatherData.utc_offset_seconds) % 3600) / 60);
        const sign = weatherData.utc_offset_seconds >= 0 ? "+" : "-";
        utcOffset = `UTC${sign}${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
      }
    }
    
    timezoneInfo = ` (${timezoneDisplay}${utcOffset && typeof weatherData.timezone === "string" ? `, ${utcOffset}` : ""})`;
  }


  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Подробная информация о погоде</title>
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
          <h1>🌡️ Подробная информация о погоде</h1>
          <div class="location">📍 ${locationString}</div>
          <div style="margin-top: 8px; font-size: 12px; color: #666;">
            API: ${API_PROVIDER === 'openweathermap' ? 'OpenWeatherMap' : 'Open-Meteo'}
            ${API_PROVIDER === 'openweathermap' && weatherData.cityId ? ` | <a href="https://old.openweathermap.org/city/${weatherData.cityId}" target="_blank" style="color: #1976d2; text-decoration: none;">Открыть на OpenWeatherMap</a>` : ''}
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
              <div class="current-detail-label">Ощущается как</div>
              <div class="current-detail-value">${weatherData.current.apparent_temperature}°</div>
            </div>
            ` : ''}
            <div class="current-detail-item">
              <div class="current-detail-label">Ветер</div>
              <div class="current-detail-value">${getWindDirection(weatherData.current.winddirection)} ${weatherData.current.winddirection}°, ${weatherData.current.windspeed} м/с ${getWindDescription(weatherData.current.windspeed)}</div>
            </div>
            ${weatherData.current.cloudcover !== undefined ? `
            <div class="current-detail-item">
              <div class="current-detail-label">Облачность</div>
              <div class="current-detail-value">${weatherData.current.cloudcover}% ${weatherData.current.cloudcover >= 75 ? "пасмурно" : weatherData.current.cloudcover >= 50 ? "облачно" : "малооблачно"}</div>
            </div>
            ` : ''}
            ${weatherData.current.surface_pressure !== undefined ? `
            <div class="current-detail-item">
              <div class="current-detail-label">Давление</div>
              <div class="current-detail-value">${weatherData.current.surface_pressure} hPa</div>
            </div>
            ` : ''}
            ${weatherData.current.relativehumidity_2m !== undefined ? `
            <div class="current-detail-item">
              <div class="current-detail-label">Влажность</div>
              <div class="current-detail-value">${weatherData.current.relativehumidity_2m}%</div>
            </div>
            ` : ''}
            ${weatherData.current.visibility !== undefined ? `
            <div class="current-detail-item">
              <div class="current-detail-label">Видимость</div>
              <div class="current-detail-value">${weatherData.current.visibility} км</div>
            </div>
            ` : ''}
            ${weatherData.current.dewpoint_2m !== undefined ? `
            <div class="current-detail-item">
              <div class="current-detail-label">Точка росы</div>
              <div class="current-detail-value">${weatherData.current.dewpoint_2m}°</div>
            </div>
            ` : ''}
            ${weatherData.current.dewpoint_2m !== undefined ? `
            <div class="current-detail-item">
              <div class="current-detail-label">Комфорт</div>
              <div class="current-detail-value">${getComfortLevel(weatherData.current.dewpoint_2m, weatherData.current.relativehumidity_2m)}</div>
            </div>
            ` : ''}
            ${weatherData.current.precipitation !== undefined ? `
            <div class="current-detail-item">
              <div class="current-detail-label">Осадки</div>
              <div class="current-detail-value">${weatherData.current.precipitation > 0 ? weatherData.current.precipitation + " мм" : "нет"}</div>
            </div>
            ` : ''}
            ${weatherData.daily[0]?.sunrise ? `
            <div class="current-detail-item">
              <div class="current-detail-label">Восход</div>
              <div class="current-detail-value">${formatTime(weatherData.daily[0].sunrise)}</div>
            </div>
            ` : ''}
            ${weatherData.daily[0]?.sunset ? `
            <div class="current-detail-item">
              <div class="current-detail-label">Закат</div>
              <div class="current-detail-value">${formatTime(weatherData.daily[0].sunset)}</div>
            </div>
            ` : ''}
            ${weatherData.daily[0]?.sunrise && weatherData.daily[0]?.sunset ? `
            <div class="current-detail-item">
              <div class="current-detail-label">День</div>
              <div class="current-detail-value">${calculateDaylight(weatherData.daily[0].sunrise, weatherData.daily[0].sunset)}</div>
            </div>
            ` : ''}
            ${weatherData.current.uv_index !== undefined ? `
            <div class="current-detail-item">
              <div class="current-detail-label">УФ индекс</div>
              <div class="current-detail-value">${weatherData.current.uv_index} ${getUVDescription(weatherData.current.uv_index)}</div>
            </div>
            ` : ''}
            <div class="current-detail-item">
              <div class="current-detail-label">Время обновления</div>
              <div class="current-detail-value">${timeStr}${timezoneInfo}</div>
            </div>
          </div>
        </div>
        
        <div class="update-time">
          Данные обновлены: ${timeStr}${timezoneInfo}
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
    title: "Подробная информация о погоде — Tray Weather",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    resizable: true,
  });

  // Очищаем ссылку при закрытии окна
  weatherWindow.on('closed', () => {
    weatherWindow = null;
  });

  // Обработка кликов по ссылкам через webContents
  weatherWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Обработка навигации (если пользователь кликнет на ссылку)
  weatherWindow.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    shell.openExternal(url);
  });

  weatherWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

/**
 * Показывает окно с последними API-запросами
 */
function showApiRequests(): void {
  // Проверяем, не открыто ли окно уже
  if (requestWindow && !requestWindow.isDestroyed()) {
    if (requestWindow.isMinimized()) {
      requestWindow.restore();
    }
    requestWindow.show();
    requestWindow.focus();
    return;
  }

  // Форматируем запросы для HTML-отображения
  const requestsHtml = apiRequests.length === 0
    ? '<div style="text-align: center; padding: 40px; color: #666; font-size: 14px;"><p style="margin-bottom: 8px; font-weight: 500;">Запросов не было</p><p style="font-size: 12px; color: #999;">История запросов пуста.</p></div>'
    : apiRequests
    .slice()
    .reverse() // Показываем последние запросы первыми
    .map((req, index) => {
      const timeStr = req.timestamp.toLocaleTimeString("ru-RU", {
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
          <div class="request-section-title">Заголовки запроса:</div>
          <pre class="request-pre">${headersStr}</pre>
        </div>`;
      } else {
        requestHeadersHtml = `<div class="request-section">
          <div class="request-section-title">Заголовки запроса:</div>
          <pre class="request-pre">(нет заголовков)</pre>
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
          <div class="request-section-title">HTTP статус:</div>
          <div class="status-code status-${req.responseStatus}">${req.responseStatus} ${statusText}</div>
        </div>`;
      }
      
      let responseHeadersHtml = "";
      if (req.responseHeaders && Object.keys(req.responseHeaders).length > 0) {
        const headersStr = Object.entries(req.responseHeaders)
          .map(([key, value]) => `${escapeHtml(key)}: ${escapeHtml(value)}`)
          .join("\n");
        responseHeadersHtml = `<div class="request-section">
          <div class="request-section-title">Заголовки ответа:</div>
          <pre class="request-pre">${headersStr}</pre>
        </div>`;
      }
      
      let responseBodyHtml = "";
      if (req.responseBody) {
        const bodyStr = escapeHtml(req.responseBody);
        responseBodyHtml = `<div class="request-section">
          <div class="request-section-title">Тело ответа:</div>
          <pre class="request-pre response-body">${bodyStr}</pre>
        </div>`;
      }
      
      const durationStr = req.duration !== undefined ? ` (${req.duration} мс)` : "";
      
      return `
        <div class="request-item">
          <div class="request-number">${apiRequests.length - index}.</div>
          <div class="request-content">
            <div class="request-time">[${timeStr}]${durationStr}</div>
            <div class="request-api"><strong>${escapedApi}</strong></div>
            <div class="request-url"><strong>URL:</strong> <a href="${escapedUrl}" class="url-link">${escapedUrl}</a></div>
            <div class="request-method"><strong>Метод:</strong> ${escapeHtml(req.method)}</div>
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
      <title>История API-запросов (${apiRequests.length} из ${MAX_REQUESTS} максимально хранящихся)</title>
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
        <h1>История API-запросов (${apiRequests.length} из ${MAX_REQUESTS} максимально хранящихся)</h1>
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
    title: `История API-запросов (${apiRequests.length} из ${MAX_REQUESTS})`,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  // Очищаем ссылку при закрытии окна
  requestWindow.on('closed', () => {
    requestWindow = null;
  });

  requestWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  // Обработка кликов по ссылкам
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
 * Показывает окно с последними ошибками API (с прокруткой и кликабельными ссылками)
 */
function showApiErrors(): void {
  // Проверяем, не открыто ли окно уже
  if (errorWindow && !errorWindow.isDestroyed()) {
    if (errorWindow.isMinimized()) {
      errorWindow.restore();
    }
    errorWindow.show();
    errorWindow.focus();
    return;
  }

  // Форматируем ошибки для HTML-отображения
  const errorsHtml = apiErrors.length === 0
    ? '<div style="text-align: center; padding: 40px; color: #666; font-size: 14px;"><p style="margin-bottom: 8px; font-weight: 500;">Ошибок не было</p><p style="font-size: 12px; color: #999;">Все запросы к API выполнялись успешно.</p></div>'
    : apiErrors
    .map((err, index) => {
      const timeStr = err.timestamp.toLocaleTimeString("ru-RU", {
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
        statusCodeHtml = `<div class="error-status"><strong>HTTP статус:</strong> <span class="status-code status-${err.statusCode}">${err.statusCode} ${statusText}</span></div>`;
      }
      
      let errorCodeHtml = "";
      if (err.errorCode) {
        const errorCodeDesc = err.errorCode === "ENOTFOUND" ? " (DNS lookup failed - не удалось найти хост)" :
                             err.errorCode === "ECONNREFUSED" ? " (Connection refused - соединение отклонено)" :
                             err.errorCode === "ETIMEDOUT" ? " (Timeout - превышено время ожидания)" :
                             err.errorCode === "ECONNRESET" ? " (Connection reset - соединение сброшено)" :
                             err.errorCode === "EAI_AGAIN" ? " (DNS lookup failed - временная ошибка DNS)" :
                             "";
        errorCodeHtml = `<div class="error-code"><strong>Код ошибки:</strong> <span class="code-value">${err.errorCode}${errorCodeDesc}</span></div>`;
      }
      
      let detailsHtml = "";
      if (err.details) {
        const escapedDetails = escapeHtml(err.details);
        detailsHtml = `<div class="error-details"><strong>Детали:</strong><pre class="details-pre">${escapedDetails}</pre></div>`;
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
      <title>История ошибок API (${apiErrors.length} из ${MAX_ERRORS} максимально хранящихся)</title>
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
        /* Стили для скроллбара */
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
        <h1>История ошибок API (${apiErrors.length} из ${MAX_ERRORS} максимально хранящихся)</h1>
      </div>
      <div class="error-list">
        ${errorsHtml}
      </div>
    </body>
    </html>
  `;

  // Создаём окно для отображения ошибок
  const windowSize = { width: 800, height: 600 };
  const windowPosition = getWindowPositionOnPrimaryDisplay(windowSize.width, windowSize.height);
  errorWindow = new BrowserWindow({
    width: windowSize.width,
    height: windowSize.height,
    x: windowPosition.x,
    y: windowPosition.y,
    title: `История ошибок API (${apiErrors.length} из ${MAX_ERRORS})`,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  // Очищаем ссылку при закрытии окна
  errorWindow.on('closed', () => {
    errorWindow = null;
  });

  // Загружаем HTML-контент
  errorWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  // Обработка кликов по ссылкам через webContents
  errorWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Обработка навигации (если пользователь кликнет на ссылку)
  errorWindow.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    shell.openExternal(url);
  });
}

/**
 * Получает координаты по названию города и страны через Geocoding API
 */
async function fetchCoordinatesByCity(city: string, country: string): Promise<{ latitude: number; longitude: number; cityName: string; countryName: string } | null> {
  // Используем count=10 чтобы получить больше результатов и найти наиболее подходящий
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&country=${encodeURIComponent(country)}&count=10&language=en`;
  console.log({url});
  const startTime = Date.now();
  try {
    const res = await fetch(url);
    const duration = Date.now() - startTime;
    
    // Получаем заголовки ответа
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    
    // Получаем тело ответа
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
      addApiError("Geocoding API (поиск координат)", error, url, { statusCode: res.status });
      addApiRequest("Geocoding API (поиск координат)", url, "GET", undefined, res.status, responseHeaders, responseBody, duration);
      return null;
    }
    
    addApiRequest("Geocoding API (поиск координат)", url, "GET", undefined, res.status, responseHeaders, responseBody, duration);
    
    const data: any = JSON.parse(responseText);
    if (data && data.results && data.results.length > 0) {
      // Нормализуем названия для сравнения
      const cityLower = city.toLowerCase().trim();
      const countryLower = country.toLowerCase().trim();
      
      // Функция для нормализации названия страны (убираем лишние пробелы, приводим к нижнему регистру)
      const normalizeCountry = (countryName: string): string => {
        return countryName.toLowerCase().trim();
      };
      
      // Сначала ищем точное совпадение по городу И стране
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
      
      // Если не нашли точное совпадение по городу и стране, ищем точное совпадение только по городу
      const exactMatchCity = data.results.find((loc: any) => 
        loc.name && loc.name.toLowerCase().trim() === cityLower
      );
      
      // Если нашли точное совпадение по городу, используем его, иначе берём первый результат
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
    // Извлекаем код ошибки, если он есть
    const errorCode = (err as any)?.code;
    addApiError("Geocoding API (поиск координат)", error, url, errorCode ? { errorCode } : undefined);
    console.error("Failed to fetch coordinates:", err);
    return null;
  }
}

/**
 * Получает название города и страны по координатам через Geocoding API
 */
async function fetchLocationByCoordinates(latitude: number, longitude: number): Promise<{ cityName: string; countryName: string } | null> {
  // Используем Nominatim (OpenStreetMap) для reverse geocoding, так как Open-Meteo не поддерживает это
  // Nominatim - бесплатный и не требует API ключа
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&addressdetails=1&accept-language=ru`;
  console.log({url});
  const startTime = Date.now();
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'WeatherApp/1.0' // Nominatim требует User-Agent
      }
    });
    const duration = Date.now() - startTime;
    
    // Получаем заголовки ответа
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    
    // Получаем тело ответа
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
      addApiError("Nominatim API (поиск местоположения)", error, url, { statusCode: res.status });
      addApiRequest("Nominatim API (поиск местоположения)", url, "GET", undefined, res.status, responseHeaders, responseBody, duration);
      return null;
    }
    
    addApiRequest("Nominatim API (поиск местоположения)", url, "GET", undefined, res.status, responseHeaders, responseBody, duration);
    
    const data: any = JSON.parse(responseText);
    
    // Проверяем наличие ошибки в ответе
    if (data && data.error) {
      const errorMessage = data.error || "Unknown error from API";
      const error = new Error(`API error: ${errorMessage}`);
      addApiError("Nominatim API (поиск местоположения)", error, url);
      console.error("API returned error:", errorMessage);
      return null;
    }
    
    // Nominatim возвращает данные в формате address
    if (data && data.address) {
      const address = data.address;
      // Извлекаем название города и страны из адреса
      // Nominatim может возвращать разные поля в зависимости от типа местоположения
      const cityName = address.city || address.town || address.village || address.municipality || address.county || "";
      const countryName = address.country || "";
      
      if (cityName || countryName) {
        return {
          cityName: cityName,
          countryName: countryName,
        };
      }
    }
    
    // Если данных нет, это не ошибка - просто нет данных для этих координат
    console.log("No location found for coordinates:", latitude, longitude);
    return null;
  } catch (err) {
    const duration = Date.now() - startTime;
    const error = err instanceof Error ? err : new Error(String(err));
    // Извлекаем код ошибки, если он есть
    const errorCode = (err as any)?.code;
    addApiError("Nominatim API (поиск местоположения)", error, url, errorCode ? { errorCode } : undefined);
    addApiRequest("Nominatim API (поиск местоположения)", url, "GET", undefined, undefined, undefined, undefined, duration);
    console.error("Failed to fetch location info:", err);
    return null;
  }
}

/**
 * Инициализирует координаты и названия местоположения
 */
async function initializeLocation(): Promise<boolean> {
  // Если координаты не указаны, но указаны город и страна
  if ((LATITUDE === null || LONGITUDE === null) && CITY && COUNTRY) {
    console.log(`Определение координат для ${CITY}, ${COUNTRY}...`);
    const location = await fetchCoordinatesByCity(CITY, COUNTRY);
    if (location) {
      LATITUDE = location.latitude;
      LONGITUDE = location.longitude;
      cityName = location.cityName;
      countryName = location.countryName;
      // Генерируем URL в зависимости от выбранного API провайдера
      if (API_PROVIDER === 'openweathermap' && API_KEY) {
        WEATHER_URL = `https://api.openweathermap.org/data/2.5/weather?lat=${LATITUDE}&lon=${LONGITUDE}&appid=${API_KEY}&units=metric`;
      } else {
        WEATHER_URL = `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}&current_weather=true&windspeed_unit=ms`;
      }
      console.log(`Координаты определены: ${LATITUDE}, ${LONGITUDE}`);
      console.log(`Местоположение: ${cityName}, ${countryName}`);
      return true;
    } else {
      console.error("Не удалось определить координаты");
      return false;
    }
  }
  // Если координаты указаны напрямую (в коде или через предыдущий запрос)
  if (LATITUDE !== null && LONGITUDE !== null) {
    // Всегда обновляем WEATHER_URL при инициализации, чтобы использовать актуальные координаты
    // Генерируем URL в зависимости от выбранного API провайдера
    if (API_PROVIDER === 'openweathermap' && API_KEY) {
      WEATHER_URL = `https://api.openweathermap.org/data/2.5/weather?lat=${LATITUDE}&lon=${LONGITUDE}&appid=${API_KEY}&units=metric`;
    } else {
      WEATHER_URL = `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}&current_weather=true&windspeed_unit=ms`;
    }
    console.log(`Используются координаты: ${LATITUDE}, ${LONGITUDE}`);
    
    // Получаем название города и страны по координатам
    // Если используются только координаты (CITY и COUNTRY undefined), всегда получаем названия
    // Также получаем, если названия еще не были получены
    if ((CITY === undefined && COUNTRY === undefined) || !cityName || !countryName) {
      const location = await fetchLocationByCoordinates(LATITUDE, LONGITUDE);
      if (location) {
        cityName = location.cityName;
        countryName = location.countryName;
        console.log(`Местоположение обновлено по координатам: ${cityName}, ${countryName}`);
      }
    }
    return true;
  }
  
  const error = new Error("Не указаны ни координаты, ни город и страна!");
  addApiError("Инициализация", error);
  console.error("Не указаны ни координаты, ни город и страна!");
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
  timezone?: string | number; // Для OpenWeatherMap - число (offset в секундах), для Open-Meteo - строка (название таймзоны)
  utc_offset_seconds?: number;
  cityId?: number; // City ID для OpenWeatherMap (для ссылки)
}

async function fetchWeatherData(): Promise<WeatherData | null> {
  if (!WEATHER_URL) {
    const error = new Error("WEATHER_URL не инициализирован");
    addApiError("Weather API", error);
    console.error("WEATHER_URL не инициализирован");
    return null;
  }
  
  const startTime = Date.now();
  try {
    const res = await fetch(WEATHER_URL);
    const duration = Date.now() - startTime;
    
    // Получаем заголовки ответа
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    
    // Получаем тело ответа
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
    
    // Обрабатываем ответ в зависимости от API провайдера
    if (API_PROVIDER === 'openweathermap') {
      // OpenWeatherMap API формат
      if (data && data.main && typeof data.main.temp === "number") {
        // Конвертируем weather code из OpenWeatherMap в формат WMO
        const owmCode = data.weather && data.weather[0] && typeof data.weather[0].id === "number" 
          ? data.weather[0].id 
          : 800; // По умолчанию ясно (800 = Clear sky в OpenWeatherMap)
        const weathercode = convertOpenWeatherMapToWMO(owmCode);
        console.log(`OpenWeatherMap: код ${owmCode} конвертирован в WMO ${weathercode}`);
        return {
          temperature: data.main.temp,
          weathercode: weathercode
        };
      }
    } else {
      // Open-Meteo API формат
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
    
    const error = new Error("Неверный формат ответа API: отсутствует температура");
    addApiError("Weather API", error, WEATHER_URL);
    return null;
  } catch (err) {
    const duration = Date.now() - startTime;
    const error = err instanceof Error ? err : new Error(String(err));
    // Извлекаем код ошибки, если он есть
    const errorCode = (err as any)?.code;
    addApiError("Weather API", error, WEATHER_URL, errorCode ? { errorCode } : undefined);
    addApiRequest("Weather API", WEATHER_URL, "GET", undefined, undefined, undefined, undefined, duration);
    console.error("Failed to fetch weather:", err);
    return null;
  }
}

/**
 * Получает расширенные данные о погоде с прогнозом
 */
async function fetchExtendedWeatherData(): Promise<ExtendedWeatherData | null> {
  if (LATITUDE === null || LONGITUDE === null) {
    return null;
  }
  
  // URL для получения расширенных данных в зависимости от API провайдера
  let extendedUrl: string;
  let currentWeatherUrl: string | null = null;
  if (API_PROVIDER === 'openweathermap' && API_KEY) {
    // Для OpenWeatherMap используем ТОЛЬКО текущую погоду (/data/2.5/weather)
    // НЕ используем /forecast API
    currentWeatherUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${LATITUDE}&lon=${LONGITUDE}&appid=${API_KEY}&units=metric`;
    extendedUrl = ""; // Не используется для OpenWeatherMap
  } else {
    // Open-Meteo API: расширенные данные с прогнозом на 7 дней и почасовым прогнозом на сегодня
    // Включаем все доступные параметры: feels like, облачность, давление, влажность, точка росы, осадки, УФ индекс
    extendedUrl = `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}&current_weather=true&daily=temperature_2m_max,temperature_2m_min,weathercode,sunrise,sunset&hourly=temperature_2m,weathercode,apparent_temperature,cloudcover,pressure_msl,relativehumidity_2m,dewpoint_2m,precipitation,uv_index&current=apparent_temperature,cloudcover,surface_pressure,relativehumidity_2m,dewpoint_2m,precipitation,uv_index,visibility&windspeed_unit=ms&timezone=auto&forecast_days=7`;
  }
  
  const startTime = Date.now();
  try {
    // Для OpenWeatherMap получаем только текущую погоду
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
          addApiRequest("Weather API (текущая погода)", currentWeatherUrl, "GET", undefined, currentRes.status, currentResponseHeaders, currentResponseBody, currentDuration);
        } else {
          const error = new Error(`HTTP error ${currentRes.status} ${currentRes.statusText}`);
          addApiError("Weather API (текущая погода)", error, currentWeatherUrl, { statusCode: currentRes.status });
          addApiRequest("Weather API (текущая погода)", currentWeatherUrl, "GET", undefined, currentRes.status, currentResponseHeaders, currentResponseBody, currentDuration);
          console.error("Не удалось получить текущую погоду от OpenWeatherMap");
          return null;
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        addApiError("Weather API (текущая погода)", error, currentWeatherUrl);
        console.error("Ошибка при получении текущей погоды от OpenWeatherMap:", err);
        return null;
      }
      
      // Для OpenWeatherMap возвращаем только текущие данные, без прогноза
      if (!currentWeatherData) {
        console.error("Не удалось получить текущую погоду от OpenWeatherMap /weather API");
        return null;
      }
      
      const current = currentWeatherData;
      const currentMain = current.main || {};
      const currentWeather = current.weather && current.weather[0] ? current.weather[0] : {};
      const currentSys = current.sys || {};
      
      // Конвертируем текущий код погоды из OpenWeatherMap в WMO
      const currentOwmCode = currentWeather.id || 800;
      const currentWmoCode = convertOpenWeatherMapToWMO(currentOwmCode);
      
      // Конвертируем sunrise и sunset из Unix timestamp в ISO строку
      const sunrise = currentSys.sunrise ? new Date(currentSys.sunrise * 1000).toISOString() : undefined;
      const sunset = currentSys.sunset ? new Date(currentSys.sunset * 1000).toISOString() : undefined;
      
      // Создаем daily массив с восходом и закатом для отображения
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
          surface_pressure: currentMain.pressure ? currentMain.pressure : undefined, // OpenWeatherMap возвращает давление в hPa
          relativehumidity_2m: currentMain.humidity,
          dewpoint_2m: undefined, // OpenWeatherMap не предоставляет точку росы напрямую
          precipitation: current.rain ? (current.rain['3h'] || 0) : undefined,
          uv_index: undefined, // OpenWeatherMap не предоставляет UV индекс в базовом API
          visibility: current.visibility ? current.visibility / 1000 : undefined, // Конвертируем из метров в километры
        },
        daily: dailyWithSun, // Добавляем восход и закат для отображения
        hourly: [], // Нет прогноза для OpenWeatherMap
        timezone: current.timezone ? current.timezone : undefined,
        utc_offset_seconds: undefined,
        cityId: current.id, // Сохраняем city ID для ссылки на OpenWeatherMap
      };
    }
    
    // Для Open-Meteo делаем запрос к extendedUrl
    const res = await fetch(extendedUrl);
    const duration = Date.now() - startTime;
    
    // Получаем заголовки ответа
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    
    // Получаем тело ответа
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
      addApiError("Weather API (расширенные данные)", error, extendedUrl, { statusCode: res.status });
      addApiRequest("Weather API (расширенные данные)", extendedUrl, "GET", undefined, res.status, responseHeaders, responseBody, duration);
      return null;
    }
    
    addApiRequest("Weather API (расширенные данные)", extendedUrl, "GET", undefined, res.status, responseHeaders, responseBody, duration);
    
    const data: any = JSON.parse(responseText);
    
    // Обрабатываем ответ Open-Meteo API
    
    // Open-Meteo API формат
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
      
      // Обрабатываем почасовые данные на сегодня (только будущие часы)
      const hourlyForecast: Array<{ time: string; temperature: number; weathercode: number }> = [];
      if (data.hourly && data.hourly.time && data.hourly.temperature_2m && data.hourly.weathercode) {
        const now = new Date();
        const today = new Date();
        const todayDateStr = today.toISOString().split('T')[0]; // YYYY-MM-DD
        
        for (let i = 0; i < data.hourly.time.length; i++) {
          const hourTime = new Date(data.hourly.time[i]);
          const hourDateStr = hourTime.toISOString().split('T')[0];
          
          // Берем только данные на сегодня и только будущие часы
          if (hourDateStr === todayDateStr && hourTime > now) {
            hourlyForecast.push({
              time: data.hourly.time[i],
              temperature: data.hourly.temperature_2m[i],
              weathercode: data.hourly.weathercode[i],
            });
          }
        }
      }
      
      // Получаем текущие значения ТОЛЬКО из current, НЕ используем данные из прогноза
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
    addApiError("Weather API (расширенные данные)", error, extendedUrl, errorCode ? { errorCode } : undefined);
    addApiRequest("Weather API (расширенные данные)", extendedUrl, "GET", undefined, undefined, undefined, undefined, duration);
    console.error("Failed to fetch extended weather:", err);
    return null;
  }
}

/**
 * Создаёт PNG-иконку с текстом температуры через canvas.
 * По аналогии с рабочим примером из другого проекта.
 */
function createTemperatureIcon(text: string): NativeImage {
  // Увеличиваем размер для лучшего качества и видимости текста
  const size = 32; // Увеличил размер canvas
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");

  // Прозрачный фон (не рисуем фон, canvas по умолчанию прозрачный)
  // Определяем цвет текста в зависимости от состояния
  let textColor: string;

  if (text === "--" || text === "NA") {
    // Прочерк или ошибка: светло-серый
    textColor = "#999999";
  } else {
    // Активная температура: темно-серый
    textColor = "#424242";
  }

  // Настройки текста
  ctx.fillStyle = textColor;
  // Если текст больше 2 символов (например "-13°"), уменьшаем размер шрифта
  const textLength = text.length;
  let fontSizeMultiplier = isWindows ? 0.5 : 0.75;
  if (textLength > 2) {
    // Уменьшаем размер шрифта для длинных текстов
    fontSizeMultiplier *= 0.75; // Уменьшаем на 25%
  }
  const fontSize = size * fontSizeMultiplier;
  ctx.font = `bold ${fontSize}px Arial`; // Увеличил размер шрифта пропорционально размеру canvas
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  
  // Рисуем текст по центру
  const textX = size / 2;
  const textY = size / 2;
  ctx.fillText(text, textX, textY);

  // Конвертируем canvas в buffer
  const buffer = canvas.toBuffer("image/png");
  
  // Отладочный вывод и сохранение тестового файла
  console.log(`Создана иконка для "${text}" (размер canvas: ${size}x${size})`);
  
  // // Сохраняем тестовый файл для отладки (можно удалить позже)
  // try {
  //   const testFile = path.join(os.tmpdir(), `weather-icon-${text.replace(/[^a-zA-Z0-9]/g, "_")}.png`);
  //   fs.writeFileSync(testFile, buffer);
  //   console.log(`Тестовый файл сохранён: ${testFile}`);
  // } catch (e) {
  //   console.warn("Не удалось сохранить тестовый файл:", e);
  // }
  
  return nativeImage.createFromBuffer(buffer);
}

function createBaseIcon(): NativeImage {
  // Базовая иконка до первой загрузки температуры
  return createTemperatureIcon("--");
}

/**
 * Конвертирует код погоды OpenWeatherMap в WMO код
 * OpenWeatherMap использует свои коды (200-804), которые нужно конвертировать в WMO (0-99)
 */
function convertOpenWeatherMapToWMO(owmCode: number): number {
  // Гроза (Thunderstorm): 200-232 -> WMO 95-99
  if (owmCode >= 200 && owmCode <= 232) {
    if (owmCode >= 230) return 99; // Thunderstorm with heavy hail
    if (owmCode >= 221) return 98; // Thunderstorm with hail
    if (owmCode >= 212) return 97; // Heavy thunderstorm
    return 95; // Thunderstorm
  }
  
  // Морось (Drizzle): 300-321 -> WMO 51-55
  if (owmCode >= 300 && owmCode <= 321) {
    if (owmCode >= 320) return 55; // Heavy intensity drizzle
    if (owmCode >= 314) return 54; // Dense intensity drizzle
    if (owmCode >= 311) return 53; // Moderate intensity drizzle
    if (owmCode >= 301) return 52; // Light intensity drizzle
    return 51; // Drizzle
  }
  
  // Дождь (Rain): 500-531 -> WMO 61-65
  if (owmCode >= 500 && owmCode <= 531) {
    if (owmCode >= 522) return 65; // Heavy intensity shower rain
    if (owmCode >= 520) return 63; // Shower rain
    if (owmCode >= 511) return 66; // Freezing rain
    if (owmCode >= 502) return 64; // Heavy intensity rain
    if (owmCode === 501) return 63; // Moderate rain
    return 61; // Light rain
  }
  
  // Снег (Snow): 600-622 -> WMO 71-77
  if (owmCode >= 600 && owmCode <= 622) {
    if (owmCode >= 621) return 77; // Heavy snow
    if (owmCode >= 616) return 73; // Sleet
    if (owmCode >= 612) return 72; // Light sleet
    if (owmCode >= 611) return 71; // Sleet
    if (owmCode >= 602) return 75; // Heavy snow
    if (owmCode === 601) return 73; // Snow
    return 71; // Light snow
  }
  
  // Атмосферные явления (туман и т.д.): 701-781 -> WMO 45-48
  if (owmCode >= 701 && owmCode <= 781) {
    if (owmCode >= 771) return 99; // Squall
    if (owmCode >= 762) return 48; // Volcanic ash
    if (owmCode >= 761) return 48; // Sand/dust whirls
    if (owmCode >= 751) return 48; // Sand
    if (owmCode >= 741) return 45; // Fog
    if (owmCode >= 731) return 48; // Sand/dust
    return 45; // Mist
  }
  
  // Ясно и облачность: 800-804 -> WMO 0-3
  if (owmCode === 800) return 0; // Clear sky
  if (owmCode === 801) return 1; // Few clouds
  if (owmCode === 802) return 2; // Scattered clouds
  if (owmCode === 803) return 2; // Broken clouds
  if (owmCode === 804) return 3; // Overcast clouds
  
  // Если код не распознан, возвращаем 0 (ясно) как значение по умолчанию
  console.warn(`Неизвестный код OpenWeatherMap: ${owmCode}, используем WMO 0 (ясно)`);
  return 0;
}

/**
 * Получает описание погодных условий по weathercode (WMO Weather interpretation codes)
 */
function getWeatherDescription(weathercode: number): string {
  if (weathercode === 0) return "Ясно";
  if (weathercode >= 1 && weathercode <= 3) return "Облачно";
  if (weathercode >= 45 && weathercode <= 48) return "Туман";
  if (weathercode >= 51 && weathercode <= 67) return "Дождь";
  if (weathercode >= 71 && weathercode <= 77) return "Снег";
  if (weathercode >= 80 && weathercode <= 99) {
    if (weathercode >= 95) return "Гроза";
    if (weathercode >= 85) return "Снегопад";
    return "Ливень";
  }
  return "Неизвестно";
}

/**
 * Получает emoji для погодных условий на основе weathercode
 */
function getWeatherEmoji(weathercode: number): string {
  // Маппинг WMO Weather interpretation codes к emoji
  if (weathercode === 0) {
    // Clear sky - ясно
    return "☀️";
  } else if (weathercode === 1) {
    // Mainly clear - преимущественно ясно
    return "🌤️";
  } else if (weathercode === 2) {
    // Partly cloudy - переменная облачность
    return "⛅";
  } else if (weathercode === 3) {
    // Overcast - пасмурно
    return "☁️";
  } else if (weathercode >= 45 && weathercode <= 48) {
    // Fog - туман
    return "🌫️";
  } else if (weathercode >= 51 && weathercode <= 55) {
    // Drizzle - морось
    return "🌦️";
  } else if (weathercode >= 56 && weathercode <= 57) {
    // Freezing drizzle - ледяная морось
    return "🌨️";
  } else if (weathercode >= 61 && weathercode <= 65) {
    // Rain - дождь
    return "🌧️";
  } else if (weathercode >= 66 && weathercode <= 67) {
    // Freezing rain - ледяной дождь
    return "🌨️";
  } else if (weathercode >= 71 && weathercode <= 77) {
    // Snow - снег
    return "❄️";
  } else if (weathercode >= 80 && weathercode <= 82) {
    // Rain showers - ливень
    return "🌦️";
  } else if (weathercode >= 85 && weathercode <= 86) {
    // Snow showers - снегопад
    return "🌨️";
  } else if (weathercode >= 95 && weathercode <= 99) {
    // Thunderstorm - гроза
    return "⛈️";
  } else {
    // Неизвестный код
    return "❓";
  }
}

// Кэш для иконок emoji
let emojiIconCache: Map<number, NativeImage> = new Map();
let emojiCacheInitialized = false;

/**
 * Инициализирует кэш цветных emoji используя BrowserWindow
 * Кэш используется только на Linux
 */
async function initializeEmojiCache(): Promise<void> {
  // Используем кэш только на Linux
  if (!isLinux) {
    emojiCacheInitialized = true;
    return;
  }
  
  if (emojiCacheInitialized) return;
  
  // Используем больший размер для лучшего качества, затем масштабируем
  const renderSize = 64; // Большой размер для качественного рендеринга
  const targetSize = isWindows ? 16 : 32; // Финальный размер иконки
  const weatherCodes = [0, 1, 2, 3, 45, 51, 56, 61, 66, 71, 80, 85, 95];
  
  // Создаём временное скрытое окно для рендеринга цветных emoji
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
    
    // HTML для отображения emoji
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
            // Масштабируем изображение до нужного размера для лучшего качества
            const scaledImage = image.resize({
              width: targetSize,
              height: targetSize,
              quality: 'best'
            });
            emojiIconCache.set(code, scaledImage);
            resolve();
          }).catch(() => {
            resolve(); // Пропускаем если не удалось
          });
        }, 100); // Увеличиваем задержку для Windows
      });
    });
  }
  
  tempWindow.close();
  emojiCacheInitialized = true;
}

/**
 * Создаёт иконку погодных условий на основе weathercode, используя цветные emoji
 */
function createWeatherIcon(weathercode: number): NativeImage {
  const targetSize = 32;
  
  // Проверяем кэш цветных emoji только на Linux
  if (isLinux && emojiIconCache.has(weathercode)) {
    const cachedImage = emojiIconCache.get(weathercode)!;
    // Убеждаемся, что размер правильный
    const size = cachedImage.getSize();
    if (size.width === targetSize && size.height === targetSize) {
      return cachedImage;
    }
    // Масштабируем если размер не совпадает
    return cachedImage.resize({
      width: targetSize,
      height: targetSize,
      quality: 'best'
    });
  }
  
  // Fallback: используем canvas с увеличенным размером для лучшего качества на Windows
  const renderSize = isWindows ? 32 : targetSize; // Рендерим в большем размере для Windows
  const canvas = createCanvas(renderSize, renderSize);
  const ctx = canvas.getContext("2d");
  
  // Пробуем использовать системные шрифты с поддержкой emoji
  const platform = os.platform();
  let fontFamily = "Arial";
  if (platform === "darwin") {
    fontFamily = "Apple Color Emoji";
  } else if (platform === "win32") {
    fontFamily = "Segoe UI Emoji";
  } else {
    fontFamily = "Noto Color Emoji";
  }
  
  // Используем больший размер шрифта для лучшего качества
  const fontSize = renderSize * 0.75;
  ctx.font = `bold ${fontSize}px ${fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  
  const emoji = getWeatherEmoji(weathercode);
  
  // Рисуем emoji по центру
  ctx.fillText(emoji, renderSize / 2, renderSize / 2);

  const buffer = canvas.toBuffer("image/png");
  let image = nativeImage.createFromBuffer(buffer);
  
  // Масштабируем до нужного размера для Windows
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
  
  // Полная температура без округления для tooltip, меню и окна подробной информации
  const fullLabel = temp !== null ? `${temp} °C` : "N/A";
  
  // Обновляем время последнего успешного обновления, если температура получена успешно
  if (temp !== null) {
    lastUpdateTime = new Date();
  }

  // Короткая надпись для самой иконки (чтобы влезала в небольшой размер) - с округлением
  const shortLabel =
    temp !== null ? `${Math.round(temp)}°` : "NA";

  // Обновляем первую иконку: рисуем температуру как текст
  const iconWithTemp = createTemperatureIcon(shortLabel);
  tray.setImage(iconWithTemp);

  // Обновляем вторую иконку: рисуем погодные условия
  const weatherIcon = createWeatherIcon(weathercode);
  weatherTray.setImage(weatherIcon);
  
  // Форматируем время последнего обновления с секундами
  let timeString = "";
  if (lastUpdateTime) {
    const hours = lastUpdateTime.getHours().toString().padStart(2, "0");
    const minutes = lastUpdateTime.getMinutes().toString().padStart(2, "0");
    const seconds = lastUpdateTime.getSeconds().toString().padStart(2, "0");
    timeString = ` (обновлено: ${hours}:${minutes}:${seconds})`;
  }

  // Tooltip при наведении для обеих иконок (одинаковый текст) - полные данные без округления
  const locationString = cityName && countryName ? `${cityName}, ${countryName}\n` : "";
  const weatherDescription = getWeatherDescription(weathercode);
  const tooltipText = `${locationString}Температура: ${fullLabel}\nПогода: ${weatherDescription}${timeString}`;
  tray.setToolTip(tooltipText);
  weatherTray.setToolTip(tooltipText);

  // Попытка отобразить текст прямо в трее (полноценно работает в macOS).
  try {
    tray.setTitle(fullLabel);
  } catch {
    // На Linux/Windows может быть проигнорировано.
  }

  // Формируем пункты меню для первой иконки (температура) - полные данные без округления
  const menuItems: any[] = [
    {
      label: `Текущая температура: ${fullLabel}`,
      enabled: false,
    },
    {
      label: `Погода: ${getWeatherDescription(weathercode)}`,
      enabled: false,
    },
    { type: "separator" },
  ];

  // Добавляем время последнего обновления, если оно есть
  if (lastUpdateTime) {
    const hours = lastUpdateTime.getHours().toString().padStart(2, "0");
    const minutes = lastUpdateTime.getMinutes().toString().padStart(2, "0");
    const seconds = lastUpdateTime.getSeconds().toString().padStart(2, "0");
    menuItems.push({
      label: `Обновлено: ${hours}:${minutes}:${seconds}`,
      enabled: false,
    });
    menuItems.push({ type: "separator" });
  }

  // Добавляем координаты, если они определены
  if (LATITUDE !== null && LONGITUDE !== null) {
    menuItems.push({
      label: `Координаты: ${LATITUDE.toFixed(4)}, ${LONGITUDE.toFixed(4)}`,
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

  // Добавляем город и страну, если они доступны
  if (cityName && countryName) {
    menuItems.push({
      label: `Город: ${cityName}`,
      enabled: false,
    });
    menuItems.push({
      label: `Страна: ${countryName}`,
      enabled: false,
    });
    menuItems.push({ type: "separator" });
  }

  // Добавляем действия
  menuItems.push({
    label: "Обновить сейчас",
    click: () => {
      void updateTrayTemperature();
    },
  });
  menuItems.push({ type: "separator" });
  menuItems.push({
    label: "Подробная информация о погоде",
    click: () => {
      void showWeatherDetails();
    },
  });
  menuItems.push({ type: "separator" });
  menuItems.push({
    label: "Настройки",
    click: () => {
      showSettings();
    },
  });
  menuItems.push({ type: "separator" });
  menuItems.push({
    label: "Как пользоваться",
    click: () => {
      showHelp();
    },
  });
  menuItems.push({ type: "separator" });
  menuItems.push({
    label: `Показать последние API-запросы${apiRequests.length > 0 ? ` (${apiRequests.length})` : ""}`,
    click: () => {
      showApiRequests();
    },
  });
  menuItems.push({ type: "separator" });
  menuItems.push({
    label: `Показать ошибки API${apiErrors.length > 0 ? ` (${apiErrors.length})` : ""}`,
    click: () => {
      showApiErrors();
    },
  });
  menuItems.push({ type: "separator" });
  menuItems.push({
    label: "Выйти",
    click: () => {
      app.quit();
    },
  });

  const contextMenu = Menu.buildFromTemplate(menuItems);
  tray.setContextMenu(contextMenu);

  // Создаём такое же меню для второй иконки (погодные условия)
  const weatherMenuItems: any[] = [
    {
      label: `Погода: ${getWeatherDescription(weathercode)}`,
      enabled: false,
    },
    {
      label: `Текущая температура: ${fullLabel}`,
      enabled: false,
    },
    { type: "separator" },
  ];

  // Добавляем время последнего обновления, если оно есть
  if (lastUpdateTime) {
    const hours = lastUpdateTime.getHours().toString().padStart(2, "0");
    const minutes = lastUpdateTime.getMinutes().toString().padStart(2, "0");
    const seconds = lastUpdateTime.getSeconds().toString().padStart(2, "0");
    weatherMenuItems.push({
      label: `Обновлено: ${hours}:${minutes}:${seconds}`,
      enabled: false,
    });
    weatherMenuItems.push({ type: "separator" });
  }

  // Добавляем координаты, если они определены
  if (LATITUDE !== null && LONGITUDE !== null) {
    weatherMenuItems.push({
      label: `Координаты: ${LATITUDE.toFixed(4)}, ${LONGITUDE.toFixed(4)}`,
      enabled: false,
    });
    weatherMenuItems.push({ type: "separator" });
  }

  // Добавляем город и страну, если они доступны
  if (cityName && countryName) {
    weatherMenuItems.push({
      label: `Город: ${cityName}`,
      enabled: false,
    });
    weatherMenuItems.push({
      label: `Страна: ${countryName}`,
      enabled: false,
    });
    weatherMenuItems.push({ type: "separator" });
  }

  // Добавляем действия
  weatherMenuItems.push({
    label: "Обновить сейчас",
    click: () => {
      void updateTrayTemperature();
    },
  });
  weatherMenuItems.push({ type: "separator" });
  weatherMenuItems.push({
    label: "Подробная информация о погоде",
    click: () => {
      void showWeatherDetails();
    },
  });
  weatherMenuItems.push({ type: "separator" });
  weatherMenuItems.push({
    label: "Настройки",
    click: () => {
      showSettings();
    },
  });
  weatherMenuItems.push({ type: "separator" });
  weatherMenuItems.push({
    label: "Как пользоваться",
    click: () => {
      showHelp();
    },
  });
  weatherMenuItems.push({ type: "separator" });
  weatherMenuItems.push({
    label: `Показать последние API-запросы${apiRequests.length > 0 ? ` (${apiRequests.length})` : ""}`,
    click: () => {
      showApiRequests();
    },
  });
  weatherMenuItems.push({ type: "separator" });
  weatherMenuItems.push({
    label: `Показать ошибки API${apiErrors.length > 0 ? ` (${apiErrors.length})` : ""}`,
    click: () => {
      showApiErrors();
    },
  });
  weatherMenuItems.push({ type: "separator" });
  weatherMenuItems.push({
    label: "Выйти",
    click: () => {
      app.quit();
    },
  });

  const weatherContextMenu = Menu.buildFromTemplate(weatherMenuItems);
  weatherTray.setContextMenu(weatherContextMenu);
}

async function createTray() {
  // Сначала инициализируем местоположение
  const initialized = await initializeLocation();
  if (!initialized) {
    console.error("Не удалось инициализировать местоположение. Приложение не запущено.");
    app.quit();
    return;
  }

  // Создаём первую иконку (температура)
  const baseIcon = createBaseIcon();
  tray = new Tray(baseIcon);
  
  // Обработчик клика левой кнопкой мыши для первой иконки
  tray.on('click', () => {
    void showWeatherDetails();
  });

  // Создаём вторую иконку (погодные условия)
  const baseWeatherIcon = createWeatherIcon(0); // Начальная иконка - ясно
  weatherTray = new Tray(baseWeatherIcon);
  
  // Обработчик клика левой кнопкой мыши для второй иконки
  weatherTray.on('click', () => {
    void showWeatherDetails();
  });

  void updateTrayTemperature();

  // Обновление с интервалом из настроек
  const updateIntervalMs = UPDATE_INTERVAL_SECONDS * 1000;
  console.log(`Интервал обновления температуры: ${UPDATE_INTERVAL_SECONDS} секунд (${updateIntervalMs} мс)`);
  updateInterval = setInterval(() => {
    void updateTrayTemperature();
  }, updateIntervalMs);
}

// Предотвращаем автоматическое закрытие приложения при закрытии всех окон
// Нам нужен только трей, окна не обязательны
app.on("window-all-closed", () => {
  // Не закрываем приложение, так как у нас есть трей
  // app.quit() будет вызван только явно через меню "Выйти"
});

// Обеспечиваем, что только один экземпляр приложения может быть запущен (если включено)
if (ALLOW_ONLY_ONE_INSTANCE) {
  const gotTheLock = app.requestSingleInstanceLock();

  if (!gotTheLock) {
    // Если другой экземпляр уже запущен, закрываем этот
    app.quit();
  } else {
    // Обрабатываем попытку запуска второго экземпляра
    app.on('second-instance', () => {
      // Если пользователь пытается запустить второй экземпляр, показываем существующие окна
      const windows = [settingsWindow, weatherWindow, requestWindow, errorWindow, helpWindow];
      for (const window of windows) {
        if (window && !window.isDestroyed()) {
          if (window.isMinimized()) window.restore();
          window.show();
          window.focus();
          break; // Показываем только первое доступное окно
        }
      }
    });

    app.whenReady().then(async () => {
      // Инициализируем кэш цветных emoji перед созданием трея
      await initializeEmojiCache();
      // Отключаем создание окна — нам нужен только трей.
      await createTray();
    });
  }
} else {
  // Если разрешено несколько экземпляров, запускаем приложение без проверки блокировки
  app.whenReady().then(async () => {
    // Инициализируем кэш цветных emoji перед созданием трея
    await initializeEmojiCache();
    // Отключаем создание окна — нам нужен только трей.
    await createTray();
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


