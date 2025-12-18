import { app, Tray, Menu, nativeImage, NativeImage, dialog } from "electron";
import { createCanvas } from "canvas";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
// Определяем путь к .env файлу (в корне проекта)
// В Electron __dirname может указывать на dist/, поэтому проверяем несколько вариантов
function getEnvPath(): string {
  // Вариант 1: если запускаем из dist/, то .env в родительской директории
  const distPath = path.join(__dirname, "..", ".env");
  if (fs.existsSync(distPath)) {
    return distPath;
  }
  
  // Вариант 2: если запускаем из корня проекта
  const rootPath = path.join(process.cwd(), ".env");
  if (fs.existsSync(rootPath)) {
    return rootPath;
  }
  
  // Вариант 3: создаём в корне проекта (где находится package.json)
  return rootPath;
}

const envPath = getEnvPath();

// Создаём .env файл с дефолтными значениями, если его нет
if (!fs.existsSync(envPath)) {
  const defaultEnvContent = `CITY=Minsk
COUNTRY=Belarus
LATITUDE=
LONGITUDE=
`;
  fs.writeFileSync(envPath, defaultEnvContent, "utf8");
  console.log(`Создан файл .env с дефолтными значениями: ${envPath}`);
}

// Загружаем переменные окружения
// @ts-ignore - dotenv может не иметь типов в некоторых версиях
const dotenv = require("dotenv");
dotenv.config({ path: envPath });
console.log(`Загружен .env файл: ${envPath}`);

// Читаем настройки местоположения из .env файла
// Можно указать ЛИБО координаты (LATITUDE, LONGITUDE), ЛИБО город и страну (CITY, COUNTRY)
const CITY: string | undefined = process.env.CITY || undefined;
const COUNTRY: string | undefined = process.env.COUNTRY || undefined;
const LATITUDE_ENV = process.env.LATITUDE;
const LONGITUDE_ENV = process.env.LONGITUDE;

// Если указаны CITY и COUNTRY, но не LATITUDE и LONGITUDE, координаты будут определены через API
let LATITUDE: number | null = null;
let LONGITUDE: number | null = null;

// Парсим координаты из .env, если они указаны
if (LATITUDE_ENV && LATITUDE_ENV.trim() !== "") {
  const parsedLat = parseFloat(LATITUDE_ENV);
  if (!isNaN(parsedLat)) {
    LATITUDE = parsedLat;
  }
}
if (LONGITUDE_ENV && LONGITUDE_ENV.trim() !== "") {
  const parsedLon = parseFloat(LONGITUDE_ENV);
  if (!isNaN(parsedLon)) {
    LONGITUDE = parsedLon;
  }
}

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
 * Показывает диалог с последними ошибками API
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

  // Форматируем ошибки для отображения
  const errorsText = apiErrors
    .map((err, index) => {
      const timeStr = err.timestamp.toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const urlStr = err.url ? `\n  URL: ${err.url}` : "";
      return `${index + 1}. [${timeStr}] ${err.api}\n  ${err.error}${urlStr}`;
    })
    .join("\n\n");

  dialog.showMessageBox({
    type: "error",
    title: `История ошибок API (${apiErrors.length} из ${MAX_ERRORS})`,
    message: `Последние ${apiErrors.length} ошибок:`,
    detail: errorsText,
    buttons: ["Закрыть"],
  });
}

/**
 * Получает координаты по названию города и страны через Geocoding API
 */
async function fetchCoordinatesByCity(city: string, country: string): Promise<{ latitude: number; longitude: number; cityName: string; countryName: string } | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&country=${encodeURIComponent(country)}&count=1&language=ru`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP error ${res.status}`);
    }
    const data: any = await res.json();
    if (data && data.results && data.results.length > 0) {
      const location = data.results[0];
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


