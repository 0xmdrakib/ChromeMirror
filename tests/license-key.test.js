'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  compactLicenseKey,
  formatLicenseKey,
  formatLicenseKeyEdit,
  formatLicenseKeyPaste,
  isCompleteLicenseKey,
} = require('../src/renderer/license-key');

const SAMPLE_KEY = 'CMIR-ABCD-EFGH-JKLM-NPQR';

test('formats a complete dashboard key without changing its characters', () => {
  assert.equal(formatLicenseKey(SAMPLE_KEY), SAMPLE_KEY);
  assert.equal(compactLicenseKey(SAMPLE_KEY), 'ABCDEFGHJKLMNPQR');
  assert.equal(isCompleteLicenseKey(SAMPLE_KEY), true);
});

test('accepts whitespace, unicode dashes, and lower-case clipboard text', () => {
  const pasted = '  cmir\u2011abcd\u2013efgh\u2014jklm\u2212npqr\r\n';
  assert.equal(formatLicenseKey(pasted), SAMPLE_KEY);
  assert.equal(isCompleteLicenseKey(pasted), true);
});

test('preserves a valid body that begins with the prefix characters', () => {
  assert.equal(
    formatLicenseKey('CMIR-CMIR-ABCD-EFGH-JKLM'),
    'CMIR-CMIR-ABCD-EFGH-JKLM'
  );
});

test('a complete pasted key replaces stale or partially typed input', () => {
  assert.deepEqual(
    formatLicenseKeyPaste('CMIR-OLD', 8, 8, SAMPLE_KEY),
    { value: SAMPLE_KEY, caret: SAMPLE_KEY.length }
  );
});

test('typing the CMIR prefix does not clear the field', () => {
  assert.equal(formatLicenseKey('C'), 'C');
  assert.equal(formatLicenseKey('CM'), 'CM');
  assert.equal(formatLicenseKey('CMI'), 'CMI');
  assert.equal(formatLicenseKey('CMIR'), 'CMIR');
});

test('typing edits preserve the logical caret position', () => {
  assert.deepEqual(
    formatLicenseKeyEdit('CMIR-9SRHV55Z', 9),
    { value: 'CMIR-9SRH-V55Z', caret: 9 }
  );
});

test('extra clipboard characters are truncated to the supported key length', () => {
  assert.equal(formatLicenseKey(`${SAMPLE_KEY}-EXTRA`), SAMPLE_KEY);
});
