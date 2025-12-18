import { app, Tray, Menu, nativeImage, NativeImage } from "electron";
import { createCanvas } from "canvas";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Coordinates for your city.
// TODO: поменяйте на свои координаты (широта/долгота).
const LATITUDE = 55.7558; // Moscow latitude as default example
const LONGITUDE = 37.6173; // Moscow longitude as default example

// Open-Meteo API (без ключа, бесплатно)
const WEATHER_URL = `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}&current_weather=true`;

let tray: Tray | null = null;
let updateInterval: NodeJS.Timeout | null = null;

async function fetchTemperatureC(): Promise<number | null> {
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

  // Короткая надпись для самой иконки (чтобы влезала в небольшой размер)
  const shortLabel =
    temp !== null ? `${Math.round(temp)}°` : "NA";

  // Обновляем саму иконку: рисуем температуру как текст
  const iconWithTemp = createTemperatureIcon(shortLabel);
  tray.setImage(iconWithTemp);

  // Tooltip при наведении
  tray.setToolTip(`Температура: ${label}`);

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

function createTray() {
  const baseIcon = createBaseIcon();
  tray = new Tray(baseIcon);

  void updateTrayTemperature();

  // Обновление раз в минуту
  updateInterval = setInterval(() => {
    void updateTrayTemperature();
  }, 60 * 1000);
}

app.whenReady().then(() => {
  // Отключаем создание окна — нам нужен только трей.
  createTray();
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


