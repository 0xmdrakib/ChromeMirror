'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  licensePageForState,
  shouldNavigateAfterRetry,
} = require('../src/main/license-routing');
const {
  DEFAULT_LICENSE_API_URL,
  selectLicenseApiUrl,
} = require('../src/main/license-endpoint');

const OFFICIAL_ENDPOINT = 'https://chromemirror.rakibhq.xyz/api/v1/license';

test('maps every license state to the correct renderer page', () => {
  assert.equal(licensePageForState('active'), 'index.html');
  assert.equal(licensePageForState('needs_activation'), 'activate.html');
  assert.equal(licensePageForState('blocked'), 'blocked.html');
  assert.equal(licensePageForState('unexpected'), 'blocked.html');
});

test('retry only navigates after active or activation-required states', () => {
  assert.equal(shouldNavigateAfterRetry('blocked'), false);
  assert.equal(shouldNavigateAfterRetry('unexpected'), false);
  assert.equal(shouldNavigateAfterRetry('active'), true);
  assert.equal(shouldNavigateAfterRetry('needs_activation'), true);
});

test('source and compiler both fall back to the official license endpoint', () => {
  assert.equal(DEFAULT_LICENSE_API_URL, OFFICIAL_ENDPOINT);

  const compiler = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'compile.js'),
    'utf8'
  );
  assert.equal(compiler.includes(OFFICIAL_ENDPOINT), true);
});

test('development can override the compiled license endpoint', () => {
  assert.equal(
    selectLicenseApiUrl({
      isPackaged: false,
      environmentUrl: 'http://127.0.0.1:43129/api/v1/license/',
      configuredUrl: OFFICIAL_ENDPOINT,
    }),
    'http://127.0.0.1:43129/api/v1/license'
  );
});

test('packaged apps ignore environment license endpoint overrides', () => {
  assert.equal(
    selectLicenseApiUrl({
      isPackaged: true,
      environmentUrl: 'https://attacker.invalid/api/v1/license',
      configuredUrl: `${OFFICIAL_ENDPOINT}/`,
    }),
    OFFICIAL_ENDPOINT
  );
  assert.equal(
    selectLicenseApiUrl({
      isPackaged: true,
      environmentUrl: 'https://attacker.invalid/api/v1/license',
    }),
    OFFICIAL_ENDPOINT
  );
});

test('renderer diagnostics are disabled in packaged apps', () => {
  const mainSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'main', 'main.js'),
    'utf8'
  );
  assert.equal(
    mainSource.includes('if (!app.isPackaged && process.env.CM_DIAG)'),
    true
  );
});
