# Playwright tests for Electron Weather App

This directory contains Playwright tests for the Electron Weather App.

## Test structure

- `helpers.ts` — helper functions for working with Electron
- `app.test.ts` — basic application startup tests
- `settings-window.test.ts` — settings window tests
- `weather-data.test.ts` — weather data retrieval and display tests
- `help-window.test.ts` — help window tests
- `data-display.test.ts` — data display checks

## Run the tests

```bash
# Install dependencies (if they are not already installed)
npm install

# Compile the app
npm run build

# Run all tests
npm test

# Run tests in UI mode
npm run test:ui

# Run tests in headed mode (with a visible browser)
npm run test:headed

# Run a specific test
npm test -- tests/app.test.ts
```

## What is tested

### Basic functionality
- ✅ App starts without errors
- ✅ App initialization
- ✅ App process stays running

### App windows
- ✅ Settings window (opening and form fields)
- ✅ Help window (content)
- ✅ Detailed weather information window

### Data display
- ✅ Temperature is displayed correctly
- ✅ Location information is displayed
- ✅ Settings work with coordinates or a city and country
- ✅ Settings form validation

## Notes

- Tests use a temporary `settings.test.json` file to isolate test data.
- Some tests may require a GUI environment for full functionality.
- Tests automatically remove temporary files after running.
