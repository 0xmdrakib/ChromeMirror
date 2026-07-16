'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { MirrorEngine } = require('../src/main/mirror-engine');

function queuedEngine() {
  const engine = new MirrorEngine();
  engine.running = true;
  engine.mirroring = true;
  engine._drainPair = () => {};
  const page = {};
  const state = {
    followers: new Map(),
    inputDebounce: new Map(),
  };
  engine.leaderPages.set(page, state);
  engine.followers.set('healthy', {
    id: 'healthy',
    name: 'Healthy',
    state: 'ready',
    queueDepth: 0,
  });
  engine.followers.set('failed', {
    id: 'failed',
    name: 'Failed',
    state: 'error',
    queueDepth: 0,
  });
  return { engine, page, state };
}

test('preserves serial event order inside each healthy follower queue', () => {
  const { engine, page, state } = queuedEngine();
  engine._broadcastEvent(page, { kind: 'click', sequence: 1 });
  engine._broadcastEvent(page, { kind: 'key', sequence: 2 });
  engine._broadcastEvent(page, { kind: 'scroll', sequence: 3 });

  const pair = state.followers.get('healthy');
  assert.deepEqual(pair.queue.map((event) => event.sequence), [1, 2, 3]);
  assert.equal(engine.followers.get('healthy').queueDepth, 3);
});

test('isolates failed followers from healthy follower event fan-out', () => {
  const { engine, page, state } = queuedEngine();
  engine._broadcastEvent(page, { kind: 'click', sequence: 1 });
  assert.equal(state.followers.get('healthy').queue.length, 1);
  assert.equal(state.followers.has('failed'), false);
});

test('closing one follower keeps the session running and exposes retry state', () => {
  const { engine } = queuedEngine();
  engine.followers.get('healthy').context = {};
  engine._onFollowerContextClosed('healthy');
  assert.equal(engine.running, true);
  assert.equal(engine.followers.get('healthy').state, 'closed');
  assert.match(engine.followers.get('healthy').lastError, /closed/i);
});

test('closing the leader stops the whole session', () => {
  const { engine } = queuedEngine();
  let stopped = false;
  engine.stop = () => {
    stopped = true;
  };
  engine._onContextClosed('Leader');
  assert.equal(stopped, true);
});

test('leader tabs maintain independent follower maps', () => {
  const engine = new MirrorEngine();
  engine.followers.set('a', { id: 'a' });
  engine.followers.set('b', { id: 'b' });

  function fakePage() {
    return { on() {}, evaluate: async () => {}, url: () => 'about:blank' };
  }

  const first = fakePage();
  const second = fakePage();
  engine._trackLeaderPage(first);
  engine._trackLeaderPage(second);

  assert.notEqual(engine.leaderPages.get(first).followers, engine.leaderPages.get(second).followers);
  assert.deepEqual(Array.from(engine.leaderPages.get(first).followers.keys()), ['a', 'b']);
  assert.deepEqual(Array.from(engine.leaderPages.get(second).followers.keys()), ['a', 'b']);
});
