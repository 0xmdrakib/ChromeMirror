'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('renderer does not redeclare the contextBridge api global', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'),
    'utf8'
  );

  assert.doesNotMatch(source, /\b(?:const|let|class)\s+api\b/);
  assert.match(source, /const bridge = window\.api;/);
});
