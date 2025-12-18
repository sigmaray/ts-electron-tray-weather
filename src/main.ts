import { app, Tray, Menu, nativeImage, NativeImage } from "electron";
import { createCanvas } from "canvas";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Настройка местоположения: укажите ЛИБО координаты, ЛИБО город и страну
// 
// Option 1: Указать координаты напрямую (раскомментируйте и укажите свои значения)
// const LATITUDE = 55.7558; // Moscow latitude
// const LONGITUDE = 37.6173; // Moscow longitude
// const CITY: string | undefined = undefined;
// const COUNTRY: string | undefined = undefined;
//
// Option 2: Указать город и страну (координаты будут определены автоматически через API)
const CITY: string | undefined = "Minsk";
// const CITY = undefined;
const COUNTRY: string | undefined = "Belarus";
// const COUNTRY = undefined;
// const LATITUDE: number | null = null;
// const LONGITUDE: number | null = null;

// Если указаны CITY и COUNTRY, но не LATITUDE и LONGITUDE, координаты будут определены через API
let LATITUDE: number | null = null;
let LONGITUDE: number | null = null;
// let LATITUDE = 55.7558; // Moscow latitude
// let LONGITUDE = 37.6173; // Moscow longitude

// Open-Meteo API (без ключа, бесплатно)
let WEATHER_URL = "";

let tray: Tray | null = null;
let updateInterval: NodeJS.Timeout | null = null;
let lastUpdateTime: Date | null = null;
let cityName: string = "";
let countryName: string = "";

/**
 * Получает координаты по названию города и страны через Geocoding API
 */
async function fetchCoordinatesByCity(city: string, country: string): Promise<{ latitude: number; longitude: number; cityName: string; countryName: string } | null> {
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&country=${encodeURIComponent(country)}&count=1&language=ru`;
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
    console.error("Failed to fetch coordinates:", err);
    return null;
  }
}

/**
 * Получает название города и страны по координатам через Geocoding API
 */
async function fetchLocationByCoordinates(latitude: number, longitude: number): Promise<{ cityName: string; countryName: string } | null> {
  try {
    // Используем reverse geocoding через search API с координатами
    const url = `https://geocoding-api.open-meteo.com/v1/search?latitude=${latitude}&longitude=${longitude}&count=1&language=ru`;
    console.log({url});
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
  
  console.error("Не указаны ни координаты, ни город и страна!");
  return false;
}

async function fetchTemperatureC(): Promise<number | null> {
  if (!WEATHER_URL) {
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
    return null;
  } catch (err) {
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

  const contextMenu = Menu.buildFromTemplate([
    {
      label: `Текущая температура: ${label}`,
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Обновить сейчас",
      click: () => {
        void updateTrayTemperature();
      },
    },
    {
      label: "Выйти",
      click: () => {
        app.quit();
      },
    },
  ]);

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


