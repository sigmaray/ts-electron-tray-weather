# Tray Weather

Tray Weather is a small Electron app that shows the current temperature in your system tray. It runs in the background and checks for updated weather at a configurable interval.

Weather is provided by Open-Meteo by default. You can also choose OpenWeatherMap and provide your own API key.

## Download and run

Open **Releases** on the project's GitHub page, download the archive for your operating system, extract it, and start the app.

- **Windows:** extract the ZIP and run `Tray Weather.exe`.
- **Linux:** extract the ZIP and run `./electron-tray-weather`. If Electron cannot start because of its sandbox, run `ELECTRON_DISABLE_SANDBOX=1 ./electron-tray-weather`.
- **macOS:** extract the macOS ZIP and open the app.

The tray icon may be hidden in the overflow area (for example, under the hidden icons arrow in Windows).

## Set your location

On first launch, the app creates `settings.json` with New York City as the default location. To change it, right-click the tray icon and choose **Settings**. Enter either:

- a **city and country**, or
- both **latitude and longitude**.

Choose an update interval in seconds, then click **Save**. The app applies valid changes immediately. You do not need to restart it.

Open-Meteo is selected by default and does not require an API key. To use OpenWeatherMap, select it in **Settings** and enter an API key.

## Use the tray menu

Right-click the tray icon to see the current temperature and location, refresh the weather, open **Settings**, view **How to use**, review recent API errors, or quit the app. Hover over the icon to see its tooltip, including the last successful update time.

The app keeps up to 100 recent API errors in memory while it is running. Choose **Show API errors** in the tray menu to inspect details such as the time, provider, message, and request URL when available.

## Run from source

Requirements: Node.js and npm.

```bash
npm install
npm run dev
```

`npm run dev` compiles the TypeScript source and starts Electron. To compile without launching the app, run `npm run build`. To create distributable ZIP archives, run `npm run build:electron`; output is written to `release/`.

Other useful commands:

```bash
npm start          # build and launch
npm run typecheck  # check TypeScript types without emitting files
npm test           # run Playwright tests
```

## Project layout

```text
src/                  Application source code
  main.ts             Electron app, tray, settings, and weather requests
  canvas.d.ts         Canvas type declarations
tests/                Playwright tests
dist/                 Compiled JavaScript (created by npm run build)
release/              Packaged archives (created by npm run build:electron)
settings.json         Local settings (created on first launch)
```

## Weather and location services

- **Open-Meteo** provides weather by default and does not require a key.
- **OpenWeatherMap** is an optional provider and requires your API key.
- Open-Meteo's geocoding service resolves city names to coordinates. Coordinate locations can also use OpenStreetMap reverse geocoding for a display name.

## License

MIT
