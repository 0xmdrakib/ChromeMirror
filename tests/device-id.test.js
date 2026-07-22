'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { isDeviceId, persistDeviceId, readDeviceId } = require('../src/main/device-id');

test('persists one stable installation device id across restarts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-mirror-device-id-'));
  const file = path.join(root, 'device-id');
  const value = '0123456789abcdef0123456789abcdef';
  try {
    assert.equal(persistDeviceId(file, value), true);
    assert.equal(readDeviceId(file), value);
    assert.equal(isDeviceId(value), true);
    assert.equal(isDeviceId('unstable-device'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
