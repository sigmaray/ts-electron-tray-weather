# Electron Tray Weather App (TypeScript)

A simple **Electron + TypeScript** app that displays the current temperature in the **system tray icon** and refreshes it **once a minute**.

It uses the free `open-meteo.com` API (no API key required).

Generated in Cursor. The code still needs review and refactoring, but it appears to work as expected.

## Features

- 🌡️ **Temperature in the tray icon** — displayed as text directly on the icon
- 🔄 **Automatic updates** — the temperature refreshes every minute
- 📍 **Flexible location settings** — specify coordinates or a city and country
- 🕐 **Last update time** — shown in the tooltip and menu
- 📊 **Location details** — coordinates, city, and country in the context menu
- 🐛 **API error history** — the latest 20 errors are saved for debugging

## Getting started

Open the **Releases** section of the GitHub repository, select the latest release, download the archive for your operating system, extract it, and run the app.

### Linux

Download `electron-tray-weather-1.0.0.zip`, extract it, and run `ELECTRON_DISABLE_SANDBOX=1 ./electron-tray-weather`.

### Windows

Download and extract `Tray.Weather-1.0.0-win.zip`, then run `Tray Weather.exe`.

Windows may warn you about running an app from an unverified source.

<img width="543" height="511" alt="image" src="https://github.com/user-attachments/assets/38307104-44eb-4c69-9c04-3b2c6dc8bd59" />

<img width="550" height="513" alt="image" src="https://github.com/user-attachments/assets/8d45a49a-f903-4c33-9de8-415e459fd419" />

You may need to enable the hidden icon in Windows.

<img width="347" height="183" alt="image" src="https://github.com/user-attachments/assets/68d214cb-0987-4f60-9202-3e05355643dd" />

<img width="829" height="695" alt="image" src="https://github.com/user-attachments/assets/3e213de5-9a2e-4799-8229-d8d264395622" />

<img width="750" height="59" alt="image" src="https://github.com/user-attachments/assets/1269f01a-0b25-4c04-8a19-5db5ee24a44d" />

### macOS

Use the `Tray.Weather-1.0.0-mac.zip` archive.

## How the app works

The app runs in the background without opening a window. A **tray icon showing the current temperature** appears in the system notification area.

**Interact with the app through the context menu:**

- Right-click the tray icon
- Choose an option from the context menu:
  - View the current temperature and location details
  - Refresh the temperature manually
  - Open **Settings**
  - View **How to use** help
  - View API error history
  - Quit the app

## Installation

```bash
npm install
```

On first launch, a `settings.json` file is created with default settings.

## Run with npm

### Development mode

```bash
npm run dev
```

### Build and run

```bash
npm run build
npm start
```

## Set the location

Settings are stored in `settings.json` in the project root. The file is created automatically with default values on first launch.

> **⚠️ Important:** By default, the app shows the weather for **New York City, United States**. To show the weather for your location, update the settings in the **Settings** dialog.

### ⚙️ Settings dialog (recommended)

Use the settings dialog to configure your location and weather provider:

1. Right-click the tray icon.
2. Select **Settings**.
3. Fill in the required fields in the window that opens.
4. Click **Save**.

The dialog validates the values and applies the settings. The app continues running with the new settings; no restart is required.

### Choose a weather provider

OpenWeatherMap provides more accurate weather data. It requires an API key, while Open-Meteo can be used without one.

To use OpenWeatherMap:

1. Open **Settings** from the tray icon's context menu.
2. Choose **OpenWeatherMap** in the **API provider** list. The API key field will appear.
3. Enter your OpenWeatherMap API key. If you don't have one, use the **Get an API key** link shown below the field.
4. Click **Save**. The app validates and applies the key immediately.

### Set the update interval

Set **Update interval (seconds)** in the Settings dialog. The default is `60` (one minute).

## Displayed information

### Tray icon

- The temperature is displayed **directly on the icon** as text (for example, `5°` or `-3°`).
- The icon refreshes every minute.

### Tooltip (on hover)

The tooltip shows:

- The city and country, if available
- The current temperature
- The time of the last successful update, including seconds

Example: `New York, United States\nTemperature: 0.2 °C (updated: 14:35:42)`

### Context menu (right-click)

The menu contains:

- The current temperature
- The time of the last update
- Coordinates (latitude and longitude)
- The city and country, if available
- **Refresh now** to update manually
- **Settings** to edit settings in the dialog
- **How to use** to view the help
- **Show API errors (N)** to view error history
- **Quit**

## API error history

The app saves the latest 20 API errors. To view them:

1. Right-click the tray icon.
2. Select **Show API errors (N)**.
3. The dialog shows details for each error:
   - Time of occurrence
   - API name
   - Error message
   - Request URL, if available

## Technical details

- **Language**: TypeScript
- **Framework**: Electron
- **Weather API**: Open-Meteo (https://api.open-meteo.com)
- **Geocoding API**: Open-Meteo Geocoding (https://geocoding-api.open-meteo.com)
- **Icon generation**: Canvas (to render the temperature text)
- **Configuration**: `settings.json`

## Project structure

```
weather/
├── src/
│   ├── main.ts          # Main application file
│   └── canvas.d.ts      # Canvas types
├── dist/                # Compiled JavaScript
├── settings.json        # Location settings (created automatically)
├── package.json
├── tsconfig.json
└── README.md
```

## Dependencies

- `electron` — framework for desktop applications
- `canvas` — library for creating images with text

## License

MIT
