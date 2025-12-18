import { app, Tray, Menu, nativeImage, NativeImage } from "electron";
import path from "node:path"; // пока не используется, но может пригодиться позже для загрузки иконки PNG

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

function createBaseIcon(): NativeImage {
  // Используем пустую прозрачную иконку, чтобы опираться на текст/tooltip.
  // При желании сюда можно подставить PNG.
  const size = 16;
  const img = nativeImage.createEmpty();
  return img.resize({ width: size, height: size });
}

async function updateTrayTemperature() {
  if (!tray) return;

  const temp = await fetchTemperatureC();
  const label = temp !== null ? `${temp.toFixed(1)} °C` : "N/A";

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


