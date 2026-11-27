const test = require('node:test');
const assert = require('node:assert/strict');
const { registerSettingsSaveHandler } = require('../../dist/settings-ipc.js');
const { defaultSettings } = require('../../dist/settings.js');

function setup(overrides = {}) {
  const handlers = new Map();
  const calls = { applied: [], saved: 0 };
  registerSettingsSaveHandler({
    handle: (channel, listener) => handlers.set(channel, listener),
    removeHandler: channel => handlers.delete(channel),
  }, {
    getCurrentSettings: () => defaultSettings(),
    isTrustedSender: sender => sender === 'settings-window',
    apply: async settings => { calls.applied.push(settings); return overrides.applyResult ?? true; },
    onSaved: () => { calls.saved += 1; },
  });
  return { handler: handlers.get('settings:save'), calls };
}

test('rejects calls from an untrusted renderer', async () => {
  const { handler, calls } = setup();
  const result = await handler({ sender: 'other-window' }, { city: 'Paris', country: 'France' });
  assert.equal(result.ok, false);
  assert.equal(calls.applied.length, 0);
});

test('validates payload before applying and reports apply failures', async () => {
  const invalid = setup();
  const invalidResult = await invalid.handler({ sender: 'settings-window' }, { latitude: 300 });
  assert.equal(invalidResult.ok, false);
  assert.equal(invalid.calls.applied.length, 0);

  const failing = setup({ applyResult: false });
  const result = await failing.handler({ sender: 'settings-window' }, { city: 'Paris', country: 'France' });
  assert.equal(result.ok, false);
  assert.equal(failing.calls.saved, 0);
});

test('applies valid settings and acknowledges successful save', async () => {
  const { handler, calls } = setup();
  const payload = { city: 'Paris', country: 'France' };
  const result = await handler({ sender: 'settings-window' }, payload);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls.applied, [payload]);
  assert.equal(calls.saved, 1);
});
