'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ProfileStore, MAX_PROFILES } = require('../src/main/profiles');

function temporaryStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-mirror-profiles-'));
  return { root, store: new ProfileStore(root) };
}

test('migrates a legacy followerId into followerIds and persists the layout default', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-mirror-migration-'));
  fs.writeFileSync(path.join(root, 'mirror-config.json'), JSON.stringify({
    profiles: [
      { id: 'leader', name: 'Leader', dir: path.join(root, 'leader') },
      { id: 'follower', name: 'Follower', dir: path.join(root, 'follower') },
    ],
    leaderId: 'leader',
    followerId: 'follower',
    settings: {},
  }));

  const store = new ProfileStore(root);
  assert.deepEqual(store.getRoles(), {
    leaderId: 'leader',
    followerIds: ['follower'],
    windowLayout: 'minimized',
  });

  const persisted = JSON.parse(fs.readFileSync(path.join(root, 'mirror-config.json'), 'utf8'));
  assert.equal('followerId' in persisted, false);
  assert.deepEqual(persisted.followerIds, ['follower']);
  assert.equal(persisted.settings.windowLayout, 'minimized');
});

test('caps managed profiles at 25 and followers at 24', () => {
  const { root, store } = temporaryStore();
  try {
    const profiles = Array.from({ length: MAX_PROFILES }, (_, index) =>
      store.create(`Profile ${index + 1}`)
    );
    assert.throws(() => store.create('Profile 26'), /up to 25 profiles/);

    const roles = store.setRoles(
      profiles[0].id,
      profiles.slice(1).map((profile) => profile.id),
      'tiled',
    );
    assert.equal(roles.followerIds.length, 24);
    assert.equal(roles.windowLayout, 'tiled');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('drops unknown and duplicate profile ids from role configuration', () => {
  const { root, store } = temporaryStore();
  try {
    const leader = store.create('Leader');
    const follower = store.create('Follower');
    const roles = store.setRoles(
      leader.id,
      [follower.id, follower.id, leader.id, 'missing'],
      'last-used',
    );
    assert.deepEqual(roles, {
      leaderId: leader.id,
      followerIds: [follower.id],
      windowLayout: 'last-used',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
