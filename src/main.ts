import { app, Tray, Menu, nativeImage, NativeImage, dialog, BrowserWindow, shell } from "electron";
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
    };
    fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 2), "utf8");
    console.log(`Создан файл settings.json с дефолтными значениями: ${settingsPath}`);
    return defaultSettings;
  }
  
  // Загружаем настройки из settings.json
  try {
    const settingsContent = fs.readFileSync(settingsPath, "utf8");
    const settings: Settings = JSON.parse(settingsContent);
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
    };
  }
}

// Загружаем настройки
const settings = loadSettings();

// Читаем настройки местоположения из settings.json
// Можно указать ЛИБО координаты (latitude, longitude), ЛИБО город и страну (city, country)
const CITY: string | undefined = settings.city;
const COUNTRY: string | undefined = settings.country;

// Если указаны CITY и COUNTRY, но не LATITUDE и LONGITUDE, координаты будут определены через API
let LATITUDE: number | null = settings.latitude ?? null;
let LONGITUDE: number | null = settings.longitude ?? null;

// Open-Meteo API (без ключа, бесплатно)
let WEATHER_URL = "";

let tray: Tray | null = null;
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
}

const apiErrors: ApiError[] = [];
const MAX_ERRORS = 20;

/**
 * Добавляет ошибку в список последних ошибок
 */
function addApiError(api: string, error: string | Error, url?: string): void {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const apiError: ApiError = {
    timestamp: new Date(),
    api,
    error: errorMessage,
    url,
  };
  
  apiErrors.push(apiError);
  
  // Ограничиваем количество ошибок до MAX_ERRORS
  if (apiErrors.length > MAX_ERRORS) {
    apiErrors.shift(); // Удаляем самую старую ошибку
  }
  
  console.error(`[${api}] Ошибка добавлена в историю:`, errorMessage);
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
        urlHtml = `<br>  <strong>URL:</strong> <a href="${escapedUrl}" class="url-link">${escapedUrl}</a>`;
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
            ${urlHtml}
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
      throw new Error(`HTTP error ${res.status}`);
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
    addApiError("Geocoding API (поиск координат)", error, url);
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
      throw new Error(`HTTP error ${res.status}`);
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
    addApiError("Geocoding API (поиск местоположения)", error, url);
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

async function fetchTemperatureC(): Promise<number | null> {
  if (!WEATHER_URL) {
    const error = new Error("WEATHER_URL не инициализирован");
    addApiError("Weather API", error);
    console.error("WEATHER_URL не инициализирован");
    return null;
  }
  
  try {
    const res = await fetch(WEATHER_URL);
    if (!res.ok) {
      throw new Error(`HTTP error ${res.status}`);
    }
    const data: any = await res.json();
    if (data && data.current_weather && typeof data.current_weather.temperature === "number") {
      return data.current_weather.temperature;
    }
    const error = new Error("Неверный формат ответа API: отсутствует температура");
    addApiError("Weather API", error, WEATHER_URL);
    return null;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    addApiError("Weather API", error, WEATHER_URL);
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

  // Определяем цвет в зависимости от состояния
  let bgColor: string;
  let textColor: string = "#FFFFFF";

  if (text === "--" || text === "NA") {
    // Прочерк или ошибка: серый
    bgColor = "#808080";
  } else {
    // Активная температура: яркий синий
    bgColor = "#1e88e5";
  }

  // Рисуем фон
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, size, size);

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

async function updateTrayTemperature() {
  if (!tray) return;

  const temp = await fetchTemperatureC();
  const label = temp !== null ? `${temp.toFixed(1)} °C` : "N/A";

  // Обновляем время последнего успешного обновления, если температура получена успешно
  if (temp !== null) {
    lastUpdateTime = new Date();
  }

  // Короткая надпись для самой иконки (чтобы влезала в небольшой размер)
  const shortLabel =
    temp !== null ? `${Math.round(temp)}°` : "NA";

  // Обновляем саму иконку: рисуем температуру как текст
  const iconWithTemp = createTemperatureIcon(shortLabel);
  tray.setImage(iconWithTemp);

  // Форматируем время последнего обновления с секундами
  let timeString = "";
  if (lastUpdateTime) {
    const hours = lastUpdateTime.getHours().toString().padStart(2, "0");
    const minutes = lastUpdateTime.getMinutes().toString().padStart(2, "0");
    const seconds = lastUpdateTime.getSeconds().toString().padStart(2, "0");
    timeString = ` (обновлено: ${hours}:${minutes}:${seconds})`;
  }

  // Tooltip при наведении
  const locationString = cityName && countryName ? `${cityName}, ${countryName}\n` : "";
  tray.setToolTip(`${locationString}Температура: ${label}${timeString}`);

  // Попытка отобразить текст прямо в трее (полноценно работает в macOS).
  try {
    tray.setTitle(label);
  } catch {
    // На Linux/Windows может быть проигнорировано.
  }

  // Формируем пункты меню
  const menuItems: any[] = [
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
}

async function createTray() {
  // Сначала инициализируем местоположение
  const initialized = await initializeLocation();
  if (!initialized) {
    console.error("Не удалось инициализировать местоположение. Приложение не запущено.");
    app.quit();
    return;
  }

  const baseIcon = createBaseIcon();
  tray = new Tray(baseIcon);

  void updateTrayTemperature();

  // Обновление раз в минуту
  updateInterval = setInterval(() => {
    void updateTrayTemperature();
  }, 60 * 1000);
}

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
});


