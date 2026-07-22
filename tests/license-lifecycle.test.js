'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { stopLicenseForShutdown } = require('../src/main/license-lifecycle');

test('normal app shutdown preserves the device activation', () => {
  let heartbeatStops = 0;
  let releases = 0;
  const license = {
    stopHeartbeat() { heartbeatStops++; },
    release() { releases++; },
  };

  stopLicenseForShutdown(license);

  assert.equal(heartbeatStops, 1);
  assert.equal(releases, 0, 'normal shutdown must never release the saved device token');
});
