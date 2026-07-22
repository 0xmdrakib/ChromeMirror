'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { replayEvent } = require('../src/main/replay');

test('coordinate fallback never guesses a link or form-submit target', async () => {
  const page = {
    locator() {
      return { count: async () => 0 };
    },
  };

  const result = await replayEvent(page, {
    kind: 'click',
    selectors: ['#missing-link'],
    frac: { x: 0.5, y: 0.5 },
    navigationIntent: true,
  }, { coordFallback: true });

  assert.deepEqual(result, { ok: false, reason: 'unsafe-coordinate-fallback-blocked' });
});
