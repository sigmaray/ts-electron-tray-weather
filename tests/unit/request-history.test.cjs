const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequestHistory } = require('../../dist/request-history.js');

test('request history bounds entries and preserves complete request URLs', () => {
  const history = createRequestHistory(1);
  history.add({ api: 'weather', url: 'https://api.test/?appid=secret', method: 'GET' });
  history.add({ api: 'weather', url: 'https://api.test/?appid=second', method: 'GET' });
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0].url, 'https://api.test/?appid=second');
});
