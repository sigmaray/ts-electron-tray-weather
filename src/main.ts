import { app, Tray, Menu, nativeImage, NativeImage, dialog, BrowserWindow, shell, ipcMain } from "electron";
import { createCanvas } from "canvas";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
// Интерфейс для настроек
interface Settings {
  city?: string;
  country?: string;
  latitude?: number | null;
  longitude?: number | null;
  updateIntervalInSeconds?: number;
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

// Open-Meteo API (без ключа, бесплатно)
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

  // Объединяем с текущими настройками (на случай частичного обновления)
  const mergedSettings: Settings = {
    ...settings,
    ...newSettings,
  };

  // Обновляем глобальные переменные
  CITY = mergedSettings.city;
  COUNTRY = mergedSettings.country;
  LATITUDE = mergedSettings.latitude ?? null;
  LONGITUDE = mergedSettings.longitude ?? null;
  UPDATE_INTERVAL_SECONDS = mergedSettings.updateIntervalInSeconds ?? 60;
  settings = mergedSettings;

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

  // Проверка: должны быть указаны либо координаты, либо город и страна
  // Объединяем с текущими настройками для проверки
  const mergedForValidation: Settings = {
    ...settings,
    ...newSettings,
  };

  const hasCoordinates = mergedForValidation.latitude !== null && mergedForValidation.latitude !== undefined &&
                         mergedForValidation.longitude !== null && mergedForValidation.longitude !== undefined;
  const hasCityCountry = mergedForValidation.city && mergedForValidation.country && 
                         mergedForValidation.city.trim() !== "" && mergedForValidation.country.trim() !== "";

  if (!hasCoordinates && !hasCityCountry) {
    errors.push("Необходимо указать либо координаты (широта и долгота), либо город и страну");
  }

  return {
    valid: errors.length === 0,
    errors,
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
      </style>
    </head>
    <body>
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

          const newSettings = {
            city: cityValue === '' ? null : cityValue,
            country: countryValue === '' ? null : countryValue,
            latitude: latitudeValue === '' ? null : (isNaN(parseFloat(latitudeValue)) ? null : parseFloat(latitudeValue)),
            longitude: longitudeValue === '' ? null : (isNaN(parseFloat(longitudeValue)) ? null : parseFloat(longitudeValue)),
            updateIntervalInSeconds: updateIntervalValue === '' ? 60 : parseInt(updateIntervalValue, 10),
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

          const hasCoordinates = newSettings.latitude !== null && newSettings.longitude !== null;
          const hasCityCountry = newSettings.city && newSettings.country;

          if (!hasCoordinates && !hasCityCountry) {
            validation.valid = false;
            validation.errors.push('Необходимо указать либо координаты, либо город и страну');
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

        // Обработка ответов от главного процесса
        ipcRenderer.on('settings-saved', () => {
          window.close();
        });

        ipcRenderer.on('settings-error', (event, errors) => {
          showValidationErrors(errors);
        });
      </script>
    </body>
    </html>
  `;

  // Создаём окно для настроек
  const settingsWindow = new BrowserWindow({
    width: 650,
    height: 600,
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
    if (event.sender !== settingsWindow.webContents) {
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
      event.sender.send('settings-saved');
      // Удаляем обработчик после успешного сохранения
      ipcMain.removeListener('save-settings', handler);
      dialog.showMessageBox(settingsWindow, {
        type: 'info',
        title: 'Настройки сохранены',
        message: 'Настройки успешно сохранены и применены.',
        buttons: ['OK'],
      }).then(() => {
        settingsWindow.close();
      });
    } else {
      // При ошибке показываем сообщение, но не закрываем окно настроек
      // чтобы пользователь мог исправить данные
      // Приложение продолжает работать с предыдущими настройками
      const errorMessage = 'Не удалось применить настройки. Проверьте правильность введённых данных (координаты или город и страна). Приложение продолжит работать с предыдущими настройками.';
      event.sender.send('settings-error', [errorMessage]);
      // Показываем диалог асинхронно, чтобы не блокировать выполнение
      dialog.showMessageBox(settingsWindow, {
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

  // Удаляем обработчик при закрытии окна
  settingsWindow.on('closed', () => {
    ipcMain.removeListener('save-settings', handler);
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

  // Создаём окно для отображения справки
  const helpWindow = new BrowserWindow({
    width: 700,
    height: 700,
    title: "Как пользоваться — Tray Weather",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
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
 * Показывает окно с последними ошибками API (с прокруткой и кликабельными ссылками)
 */
function showApiErrors(): void {
  if (apiErrors.length === 0) {
    dialog.showMessageBox({
      type: "info",
      title: "История ошибок API",
      message: "Ошибок не было",
      detail: "Все запросы к API выполнялись успешно.",
    });
    return;
  }

  // Форматируем ошибки для HTML-отображения
  const errorsHtml = apiErrors
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
      <title>История ошибок API (${apiErrors.length} из ${MAX_ERRORS})</title>
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
        <h1>История ошибок API (${apiErrors.length} из ${MAX_ERRORS})</h1>
      </div>
      <div class="error-list">
        ${errorsHtml}
      </div>
    </body>
    </html>
  `;

  // Создаём окно для отображения ошибок
  const errorWindow = new BrowserWindow({
    width: 800,
    height: 600,
    title: `История ошибок API (${apiErrors.length} из ${MAX_ERRORS})`,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
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
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&country=${encodeURIComponent(country)}&count=10&language=ru`;
  console.log({url});
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const error = new Error(`HTTP error ${res.status} ${res.statusText}`);
      addApiError("Geocoding API (поиск координат)", error, url, { statusCode: res.status });
      return null;
    }
    const data: any = await res.json();
    if (data && data.results && data.results.length > 0) {
      // Ищем точное совпадение по названию города (регистронезависимо)
      const cityLower = city.toLowerCase();
      const exactMatch = data.results.find((loc: any) => 
        loc.name && loc.name.toLowerCase() === cityLower
      );
      
      // Если нашли точное совпадение, используем его, иначе берём первый результат
      const location = exactMatch || data.results[0];
      
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
  // Используем reverse geocoding через search API с координатами
  const url = `https://geocoding-api.open-meteo.com/v1/search?latitude=${latitude}&longitude=${longitude}&count=1&language=ru`;
  console.log({url});
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const error = new Error(`HTTP error ${res.status} ${res.statusText}`);
      addApiError("Geocoding API (поиск местоположения)", error, url, { statusCode: res.status });
      return null;
    }
    const data: any = await res.json();
    if (data && data.results && data.results.length > 0) {
      const location = data.results[0];
      return {
        cityName: location.name || "",
        countryName: location.country || "",
      };
    }
    return null;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    // Извлекаем код ошибки, если он есть
    const errorCode = (err as any)?.code;
    addApiError("Geocoding API (поиск местоположения)", error, url, errorCode ? { errorCode } : undefined);
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
      WEATHER_URL = `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}&current_weather=true`;
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
    if (!WEATHER_URL) {
      WEATHER_URL = `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}&current_weather=true`;
    }
    console.log(`Используются координаты: ${LATITUDE}, ${LONGITUDE}`);
    
    // // Получаем название города и страны по координатам, если еще не получены
    // if (!cityName || !countryName) {
    //   const location = await fetchLocationByCoordinates(LATITUDE, LONGITUDE);
    //   if (location) {
    //     cityName = location.cityName;
    //     countryName = location.countryName;
    //     console.log(`Местоположение: ${cityName}, ${countryName}`);
    //   }
    // }
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

async function fetchWeatherData(): Promise<WeatherData | null> {
  if (!WEATHER_URL) {
    const error = new Error("WEATHER_URL не инициализирован");
    addApiError("Weather API", error);
    console.error("WEATHER_URL не инициализирован");
    return null;
  }
  
  try {
    const res = await fetch(WEATHER_URL);
    if (!res.ok) {
      const error = new Error(`HTTP error ${res.status} ${res.statusText}`);
      addApiError("Weather API", error, WEATHER_URL, { statusCode: res.status });
      return null;
    }
    const data: any = await res.json();
    if (data && data.current_weather && typeof data.current_weather.temperature === "number") {
      const weathercode = typeof data.current_weather.weathercode === "number" 
        ? data.current_weather.weathercode 
        : 0;
      return {
        temperature: data.current_weather.temperature,
        weathercode: weathercode
      };
    }
    const error = new Error("Неверный формат ответа API: отсутствует температура");
    addApiError("Weather API", error, WEATHER_URL);
    return null;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    // Извлекаем код ошибки, если он есть
    const errorCode = (err as any)?.code;
    addApiError("Weather API", error, WEATHER_URL, errorCode ? { errorCode } : undefined);
    console.error("Failed to fetch weather:", err);
    return null;
  }
}

/**
 * Создаёт PNG-иконку с текстом температуры через canvas.
 * По аналогии с рабочим примером из другого проекта.
 */
function createTemperatureIcon(text: string): NativeImage {
  // Увеличиваем размер для лучшего качества и видимости текста
  const size = 22; // Увеличил размер canvas
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
  ctx.font = "bold 12px Arial"; // Увеличил размер шрифта пропорционально размеру canvas
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
 * Создаёт иконку погодных условий на основе weathercode
 */
function createWeatherIcon(weathercode: number): NativeImage {
  const size = 22;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");

  // Прозрачный фон (не рисуем фон, canvas по умолчанию прозрачный)
  ctx.fillStyle = "#FFFFFF";
  ctx.strokeStyle = "#FFFFFF";
  ctx.lineWidth = 1.5;

  // Рисуем иконку в зависимости от weathercode
  if (weathercode === 0) {
    // Ясно - солнце
    const centerX = size / 2;
    const centerY = size / 2;
    const radius = 6;
    // Круг солнца
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.fill();
    // Лучи солнца
    const rayLength = 3;
    for (let i = 0; i < 8; i++) {
      const angle = (Math.PI * 2 * i) / 8;
      const startX = centerX + Math.cos(angle) * (radius + 1);
      const startY = centerY + Math.sin(angle) * (radius + 1);
      const endX = centerX + Math.cos(angle) * (radius + rayLength);
      const endY = centerY + Math.sin(angle) * (radius + rayLength);
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(endX, endY);
      ctx.stroke();
    }
  } else if (weathercode >= 1 && weathercode <= 3) {
    // Облачно - облака
    // Первое облако
    ctx.beginPath();
    ctx.arc(6, 10, 3, 0, Math.PI * 2);
    ctx.arc(9, 10, 4, 0, Math.PI * 2);
    ctx.arc(12, 10, 3, 0, Math.PI * 2);
    ctx.fill();
    // Второе облако
    ctx.beginPath();
    ctx.arc(10, 13, 2.5, 0, Math.PI * 2);
    ctx.arc(13, 13, 3.5, 0, Math.PI * 2);
    ctx.arc(16, 13, 2.5, 0, Math.PI * 2);
    ctx.fill();
  } else if (weathercode >= 45 && weathercode <= 48) {
    // Туман - горизонтальные линии
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(4, 8 + i * 3);
      ctx.lineTo(18, 8 + i * 3);
      ctx.stroke();
    }
  } else if (weathercode >= 51 && weathercode <= 67) {
    // Дождь - капли
    // Облако
    ctx.beginPath();
    ctx.arc(7, 8, 3, 0, Math.PI * 2);
    ctx.arc(10, 8, 4, 0, Math.PI * 2);
    ctx.arc(13, 8, 3, 0, Math.PI * 2);
    ctx.fill();
    // Капли дождя
    ctx.beginPath();
    ctx.moveTo(8, 12);
    ctx.lineTo(9, 16);
    ctx.lineTo(7, 16);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(12, 12);
    ctx.lineTo(13, 16);
    ctx.lineTo(11, 16);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(15, 12);
    ctx.lineTo(16, 16);
    ctx.lineTo(14, 16);
    ctx.closePath();
    ctx.fill();
  } else if (weathercode >= 71 && weathercode <= 77) {
    // Снег - снежинка
    const centerX = size / 2;
    const centerY = size / 2;
    const length = 5;
    // Вертикальная и горизонтальная линии
    ctx.beginPath();
    ctx.moveTo(centerX, centerY - length);
    ctx.lineTo(centerX, centerY + length);
    ctx.moveTo(centerX - length, centerY);
    ctx.lineTo(centerX + length, centerY);
    ctx.stroke();
    // Диагональные линии
    ctx.beginPath();
    ctx.moveTo(centerX - length * 0.7, centerY - length * 0.7);
    ctx.lineTo(centerX + length * 0.7, centerY + length * 0.7);
    ctx.moveTo(centerX - length * 0.7, centerY + length * 0.7);
    ctx.lineTo(centerX + length * 0.7, centerY - length * 0.7);
    ctx.stroke();
  } else if (weathercode >= 80 && weathercode <= 99) {
    if (weathercode >= 95) {
      // Гроза - молния
      // Облако
      ctx.beginPath();
      ctx.arc(7, 7, 3, 0, Math.PI * 2);
      ctx.arc(10, 7, 4, 0, Math.PI * 2);
      ctx.arc(13, 7, 3, 0, Math.PI * 2);
      ctx.fill();
      // Молния
      ctx.fillStyle = "#FFD700";
      ctx.beginPath();
      ctx.moveTo(10, 10);
      ctx.lineTo(12, 10);
      ctx.lineTo(11, 13);
      ctx.lineTo(13, 13);
      ctx.lineTo(9, 18);
      ctx.lineTo(11, 15);
      ctx.lineTo(9, 15);
      ctx.closePath();
      ctx.fill();
    } else if (weathercode >= 85) {
      // Снегопад - снежинка и снежинки вокруг
      const centerX = size / 2;
      const centerY = size / 2;
      const length = 4;
      // Центральная снежинка
      ctx.beginPath();
      ctx.moveTo(centerX, centerY - length);
      ctx.lineTo(centerX, centerY + length);
      ctx.moveTo(centerX - length, centerY);
      ctx.lineTo(centerX + length, centerY);
      ctx.stroke();
      // Маленькие снежинки вокруг
      ctx.beginPath();
      ctx.arc(5, 5, 1, 0, Math.PI * 2);
      ctx.arc(17, 8, 1, 0, Math.PI * 2);
      ctx.arc(6, 17, 1, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Ливень - сильный дождь
      // Облако
      ctx.beginPath();
      ctx.arc(7, 7, 3, 0, Math.PI * 2);
      ctx.arc(10, 7, 4, 0, Math.PI * 2);
      ctx.arc(13, 7, 3, 0, Math.PI * 2);
      ctx.fill();
      // Много капель
      ctx.fillStyle = "#87CEEB";
      for (let i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.moveTo(6 + i * 2.5, 11);
        ctx.lineTo(7 + i * 2.5, 17);
        ctx.lineTo(5 + i * 2.5, 17);
        ctx.closePath();
        ctx.fill();
      }
    }
  } else {
    // Неизвестно - вопросительный знак
    ctx.font = "bold 14px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("?", size / 2, size / 2);
  }

  const buffer = canvas.toBuffer("image/png");
  return nativeImage.createFromBuffer(buffer);
}

async function updateTrayTemperature() {
  if (!tray || !weatherTray) return;

  const weatherData = await fetchWeatherData();
  const temp = weatherData?.temperature ?? null;
  const weathercode = weatherData?.weathercode ?? 0;
  const label = temp !== null ? `${temp.toFixed(1)} °C` : "N/A";

  // Обновляем время последнего успешного обновления, если температура получена успешно
  if (temp !== null) {
    lastUpdateTime = new Date();
  }

  // Короткая надпись для самой иконки (чтобы влезала в небольшой размер)
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

  // Tooltip при наведении для первой иконки
  const locationString = cityName && countryName ? `${cityName}, ${countryName}\n` : "";
  tray.setToolTip(`${locationString}Температура: ${label}${timeString}`);

  // Устанавливаем tooltip для второй иконки
  const weatherDescription = getWeatherDescription(weathercode);
  weatherTray.setToolTip(`${locationString}Погода: ${weatherDescription}${timeString}`);

  // Попытка отобразить текст прямо в трее (полноценно работает в macOS).
  try {
    tray.setTitle(label);
  } catch {
    // На Linux/Windows может быть проигнорировано.
  }

  // Формируем пункты меню для первой иконки (температура)
  const menuItems: any[] = [
    {
      label: `Текущая температура: ${label}`,
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
      label: `Текущая температура: ${label}`,
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

  // Создаём вторую иконку (погодные условия)
  const baseWeatherIcon = createWeatherIcon(0); // Начальная иконка - ясно
  weatherTray = new Tray(baseWeatherIcon);

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

app.whenReady().then(async () => {
  // Отключаем создание окна — нам нужен только трей.
  await createTray();
});

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


