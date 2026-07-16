'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createWindowPlan } = require('../src/main/window-layout');
const { minimizedPlan, tiledPlan } = require('../src/main/mirror-engine');

const displays = [
  { workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
  { workArea: { x: 1920, y: 0, width: 1600, height: 900 } },
];

test('creates launch bounds for one leader and 24 followers across displays', () => {
  const ids = Array.from({ length: 25 }, (_, index) => `profile-${index}`);
  const plan = createWindowPlan(displays, ids, 'tiled');
  assert.equal(plan.size, 25);
  for (const id of ids) {
    const entry = plan.get(id);
    assert.ok(entry);
    assert.equal(entry.args.length, 2);
  }

  const secondDisplayEntries = ids
    .map((id) => plan.get(id).args.join(' '))
    .filter((args) => args.includes('--window-position=1920,'));
  assert.ok(secondDisplayEntries.length > 0);
});

test('minimized is the leader-visible layout', () => {
  const plan = createWindowPlan(displays, ['leader', 'a', 'b'], 'minimized');
  assert.equal(plan.get('leader').args.includes('--start-minimized'), false);
  assert.equal(plan.get('a').args.includes('--start-minimized'), true);
  assert.equal(plan.get('b').args.includes('--start-minimized'), true);

  const runtimePlan = minimizedPlan(displays, ['leader', 'a', 'b']);
  assert.equal(runtimePlan.get('leader').windowState, 'normal');
  assert.equal(runtimePlan.get('a').windowState, 'minimized');
});

test('runtime tiling covers every configured display without dropping profiles', () => {
  const ids = Array.from({ length: 25 }, (_, index) => `profile-${index}`);
  const plan = tiledPlan(displays, ids);
  assert.equal(plan.size, ids.length);
  assert.ok(Array.from(plan.values()).some((bounds) => bounds.left >= 1920));
  for (const bounds of plan.values()) {
    assert.ok(bounds.width > 0);
    assert.ok(bounds.height > 0);
    assert.equal(bounds.windowState, 'normal');
  }
});

test('last-used launch mode leaves Chrome positioning untouched', () => {
  const plan = createWindowPlan(displays, ['leader', 'a'], 'last-used');
  assert.deepEqual(plan.get('leader').args, []);
  assert.deepEqual(plan.get('a').args, []);
});
