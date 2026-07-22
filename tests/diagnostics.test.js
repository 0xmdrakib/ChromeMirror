'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DiagnosticsLog } = require('../src/main/diagnostics');

test('persistent diagnostics omit secrets and deduplicate identical status', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-mirror-diagnostics-'));
  try {
    const log = new DiagnosticsLog(root);
    log.write('info', 'started', { token: 'secret-token', safe: 'value' });
    const status = { running: true, mirroring: true, followers: [{ id: 'one', state: 'ready' }] };
    log.status(status);
    log.status(status);
    log.flushSync();

    const lines = fs.readFileSync(log.file, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].detail.safe, 'value');
    assert.equal('token' in lines[0].detail, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('diagnostics batch hot-path writes until an explicit flush', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-mirror-diagnostics-batch-'));
  try {
    const log = new DiagnosticsLog(root);
    for (let index = 0; index < 100; index++) log.write('event', `event ${index}`);

    assert.equal(fs.existsSync(log.file), false, 'hot-path logging must not synchronously write each event');
    log.flushSync();

    const lines = fs.readFileSync(log.file, 'utf8').trim().split(/\r?\n/);
    assert.equal(lines.length, 100, 'batching must retain every diagnostic event');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
