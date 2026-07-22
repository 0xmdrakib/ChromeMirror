'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  cleanProfileSessionRestore,
  resetProfileDirectory,
} = require('../src/main/profile-hygiene');

test('backs up and clears Chrome session restore files without touching other profile data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-mirror-hygiene-'));
  try {
    const profileDir = path.join(root, 'profiles', 'follower');
    const sessionsDir = path.join(profileDir, 'Default', 'Sessions');
    const cookiesDir = path.join(profileDir, 'Default', 'Network');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(cookiesDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, 'Session_dirty'),
      'https://feedback-pa.clients6.google.com/static/proxy.html?usegapi=1'
    );
    fs.writeFileSync(path.join(cookiesDir, 'Cookies'), 'keep signed-in data');

    const result = cleanProfileSessionRestore(profileDir, {
      now: () => Date.parse('2026-07-21T00:00:00.000Z'),
    });

    assert.equal(fs.existsSync(path.join(sessionsDir, 'Session_dirty')), false);
    assert.equal(fs.readFileSync(path.join(cookiesDir, 'Cookies'), 'utf8'), 'keep signed-in data');
    assert.equal(result.cleaned.some((entry) => entry.relativePath === 'Default/Sessions'), true);
    assert.equal(
      fs.existsSync(path.join(result.backupDir, 'Default', 'Sessions', 'Session_dirty')),
      true
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('full profile reset moves browser data aside and recreates the same profile directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-mirror-reset-'));
  try {
    const profileDir = path.join(root, 'profiles', 'follower');
    fs.mkdirSync(path.join(profileDir, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'Default', 'Preferences'), '{}');

    const result = resetProfileDirectory(profileDir, {
      now: () => Date.parse('2026-07-21T01:00:00.000Z'),
    });

    assert.equal(fs.existsSync(profileDir), true);
    assert.equal(fs.existsSync(path.join(profileDir, 'Default', 'Preferences')), false);
    assert.equal(fs.existsSync(path.join(result.backupDir, 'Default', 'Preferences')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
