const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSettingsStore, defaultSettings, validateSettings } = require('../../dist/settings.js');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tray-weather-settings-'));
  const paths = {
    appPath: path.join(root, 'app'),
    resourcesPath: path.join(root, 'resources'),
    userDataPath: path.join(root, 'user-data'),
  };
  for (const dir of Object.values(paths)) fs.mkdirSync(dir, { recursive: true });
  return { root, paths, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('creates defaults in userData when no portable marker exists', t => {
  const f = fixture();
  t.after(f.cleanup);
  const store = createSettingsStore(f.paths);
  assert.equal(store.getPath(), path.join(f.paths.userDataPath, 'settings.json'));
  assert.deepEqual(store.load(), defaultSettings());
  assert.deepEqual(JSON.parse(fs.readFileSync(store.getPath(), 'utf8')), defaultSettings());
});

test('uses the portable directory and preserves existing userData settings', t => {
  const f = fixture();
  t.after(f.cleanup);
  const portableDir = f.paths.resourcesPath;
  fs.writeFileSync(path.join(portableDir, 'portable-mode'), '');
  const previous = { ...defaultSettings(), city: 'Minsk', country: 'Belarus' };
  fs.writeFileSync(path.join(f.paths.userDataPath, 'settings.json'), JSON.stringify(previous));
  const store = createSettingsStore(f.paths);
  assert.equal(store.getPath(), path.join(portableDir, 'settings.json'));
  assert.deepEqual(store.load(), previous);
});

test('migrates legacy app-directory settings when the destination is new', t => {
  const f = fixture();
  t.after(f.cleanup);
  const legacy = { ...defaultSettings(), city: 'Reykjavik', country: 'Iceland' };
  fs.writeFileSync(path.join(f.paths.appPath, 'settings.json'), JSON.stringify(legacy));
  const store = createSettingsStore(f.paths);
  assert.deepEqual(store.load(), legacy);
  assert.equal(fs.existsSync(path.join(f.paths.userDataPath, 'settings.json')), true);
});

test('validates coordinates, provider keys, and malformed payloads', () => {
  const current = defaultSettings();
  assert.equal(validateSettings({ latitude: 55.75, longitude: 37.61, city: null, country: null }, current).valid, true);
  assert.equal(validateSettings({ latitude: 91 }, current).valid, false);
  assert.equal(validateSettings({ apiProvider: 'openweathermap', apiKey: '' }, current).valid, false);
  assert.equal(validateSettings(null, current).valid, false);
  assert.equal(validateSettings({ city: 'Paris', country: 'France', unexpected: true }, current).valid, false);
});

test('saves settings asynchronously with a complete JSON file', async t => {
  const f = fixture();
  t.after(f.cleanup);
  const store = createSettingsStore(f.paths);
  const settings = { ...defaultSettings(), city: 'Paris', country: 'France' };
  assert.equal(await store.save(settings), true);
  assert.deepEqual(JSON.parse(await fs.promises.readFile(store.getPath(), 'utf8')), settings);
  assert.deepEqual((await fs.promises.readdir(f.paths.userDataPath)).filter(name => name.endsWith('.tmp')), []);
});
