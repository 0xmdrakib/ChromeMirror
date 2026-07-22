'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MirrorEngine,
  isFollowerHelperTopLevelUrl,
  startPage,
  coalesceQueuedEvent,
} = require('../src/main/mirror-engine');

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

test('closing one follower keeps the session running and starts automatic recovery', () => {
  const { engine } = queuedEngine();
  let recoveryScheduled = false;
  engine._scheduleFollowerRecovery = () => { recoveryScheduled = true; };
  engine.followers.get('healthy').context = {};
  engine._onFollowerContextClosed('healthy');
  assert.equal(engine.running, true);
  assert.equal(engine.followers.get('healthy').state, 'recovering');
  assert.match(engine.followers.get('healthy').lastError, /closed/i);
  assert.equal(recoveryScheduled, true);
});

test('degraded followers keep receiving events instead of becoming permanently disabled', () => {
  const { engine, page, state } = queuedEngine();
  engine.followers.get('healthy').state = 'degraded';
  engine._broadcastEvent(page, { kind: 'click', sequence: 1 });
  assert.deepEqual(state.followers.get('healthy').queue.map((event) => event.sequence), [1]);
});

test('queue coalescing keeps the latest scroll and losslessly merges adjacent typing', () => {
  const scrollQueue = [{ kind: 'scroll', x: 0, y: 10, __frameUrl: 'main' }];
  assert.equal(coalesceQueuedEvent(scrollQueue, { kind: 'scroll', x: 0, y: 90, __frameUrl: 'main' }), true);
  assert.equal(scrollQueue[0].y, 90);

  const textQueue = [{
    kind: 'text-op',
    selectors: ['#mirror-test-input'],
    valueBefore: '',
    value: 'a',
    __frameUrl: 'main',
  }];
  assert.equal(coalesceQueuedEvent(textQueue, {
    kind: 'text-op',
    selectors: ['#mirror-test-input'],
    valueBefore: 'a',
    value: 'ab',
    __frameUrl: 'main',
  }), true);
  assert.equal(textQueue[0].valueBefore, '');
  assert.equal(textQueue[0].value, 'ab');
});

test('pausing keeps browser contexts open and discards pending replay work', async () => {
  const { engine, page, state } = queuedEngine();
  const leaderContext = { pages: () => [page] };
  const followerContext = { pages: () => [] };
  engine.leaderCtx = leaderContext;
  engine.followers.get('healthy').context = followerContext;
  engine._broadcastEvent(page, { kind: 'click', sequence: 1 });
  const pair = state.followers.get('healthy');
  const pendingTimer = setTimeout(() => {}, 10_000);
  state.inputDebounce.set('#field', { timer: pendingTimer, ev: { kind: 'input' } });

  const status = await engine.setMirroring(false);

  assert.equal(status.running, true);
  assert.equal(status.mirroring, false);
  assert.equal(engine.leaderCtx, leaderContext);
  assert.equal(engine.followers.get('healthy').context, followerContext);
  assert.deepEqual(pair.queue, []);
  assert.equal(pair.queueDepth, 0);
  assert.equal(engine.followers.get('healthy').queueDepth, 0);
  assert.equal(state.inputDebounce.size, 0);
});

test('paused tab activation is remembered and resume synchronizes that exact tab', async () => {
  const engine = new MirrorEngine();
  engine.running = true;
  engine.mirroring = false;
  const mainFrame = {};
  const previousPage = { url: () => 'https://example.test/previous' };
  const activePage = {
    mainFrame: () => mainFrame,
    url: () => 'https://example.test/current',
  };
  engine.activeLeaderPage = previousPage;
  engine.leaderPages.set(activePage, {
    followers: new Map(),
    inputDebounce: new Map(),
  });
  const activations = [];
  engine._activateLeaderPage = async (page) => activations.push(page);

  engine._onEvent(activePage, JSON.stringify({ kind: 'tab-activate' }), mainFrame);
  assert.equal(engine.activeLeaderPage, activePage);
  assert.deepEqual(activations, []);

  const status = await engine.setMirroring(true);
  assert.equal(status.mirroring, true);
  assert.deepEqual(activations, [activePage]);
});

test('the built-in browser home page has a functional mirror typing field', () => {
  const encoded = startPage('leader', 'Leader').replace(/^data:text\/html,/, '');
  const html = decodeURIComponent(encoded);
  assert.match(html, /id="mirror-test-input"/);
  assert.match(html, /Live typing test/);
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

test('ignores child-frame SPA navigation instead of replacing the follower page', () => {
  const engine = new MirrorEngine();
  engine.running = true;
  engine.mirroring = true;

  const mainFrame = { url: () => 'https://chromewebstore.google.com/' };
  const childFrame = {
    url: () => 'https://feedback-pa.clients6.google.com/static/proxy.html?usegapi=1',
  };
  const leaderPage = {
    mainFrame: () => mainFrame,
    url: () => 'https://chromewebstore.google.com/',
  };
  engine.leaderPages.set(leaderPage, {
    followers: new Map(),
    inputDebounce: new Map(),
  });

  const navigations = [];
  engine._syncNav = (_page, url) => navigations.push(url);
  engine._onEvent(
    leaderPage,
    JSON.stringify({
      kind: 'nav',
      href: 'https://feedback-pa.clients6.google.com/static/proxy.html?usegapi=1',
    }),
    childFrame
  );

  assert.deepEqual(navigations, []);
});

test('allows main-frame SPA navigation to update followers', () => {
  const engine = new MirrorEngine();
  engine.running = true;
  engine.mirroring = true;

  const mainFrame = { url: () => 'https://example.test/next' };
  const leaderPage = {
    mainFrame: () => mainFrame,
    url: () => 'https://example.test/next',
  };
  engine.leaderPages.set(leaderPage, {
    followers: new Map(),
    inputDebounce: new Map(),
  });

  const navigations = [];
  engine._syncNav = (_page, url) => navigations.push(url);
  engine._onEvent(
    leaderPage,
    JSON.stringify({ kind: 'nav', href: 'https://example.test/next' }),
    mainFrame
  );

  assert.deepEqual(navigations, ['https://example.test/next']);
});

test('never falls back a child-frame event to the follower top-level page', async () => {
  const engine = new MirrorEngine();
  const mainFrame = { url: () => 'https://store.test/detail' };
  const page = {
    mainFrame: () => mainFrame,
    frames: () => [mainFrame],
  };

  const target = await engine._replayTarget(page, {
    kind: 'click',
    __url: 'https://store.test/detail',
    __frameUrl: 'https://feedback.test/static/proxy.html?profile=leader',
    __mainFrame: false,
  });

  assert.equal(target, null);
});

test('matches child frames by origin and pathname when profile query strings differ', async () => {
  const engine = new MirrorEngine();
  const mainFrame = { url: () => 'https://store.test/detail' };
  const childFrame = {
    url: () => 'https://feedback.test/static/proxy.html?profile=follower',
  };
  const page = {
    mainFrame: () => mainFrame,
    frames: () => [mainFrame, childFrame],
  };

  const target = await engine._replayTarget(page, {
    kind: 'click',
    __url: 'https://store.test/detail',
    __frameUrl: 'https://feedback.test/static/proxy.html?profile=leader',
    __mainFrame: false,
  });

  assert.equal(target, childFrame);
});

test('never adopts a replay-created follower popup for the matching leader popup', async () => {
  const engine = new MirrorEngine();
  const followerOpener = {
    isClosed: () => false,
    url: () => 'https://store.test/',
  };
  let followerPopupClosed = false;
  const followerPopup = {
    isClosed: () => followerPopupClosed,
    close: async () => { followerPopupClosed = true; },
    opener: async () => followerOpener,
    on() {},
    url: () => 'https://feedback.test/static/proxy.html',
  };
  const deterministicPage = {
    isClosed: () => false,
    bringToFront: async () => {},
    on() {},
    url: () => 'about:blank',
  };
  const followerContext = {
    pages: () => [followerOpener, followerPopup, deterministicPage].filter((page) => !page.isClosed()),
    newPage: async () => deterministicPage,
  };
  engine.followers.set('follower', {
    id: 'follower',
    name: 'Follower',
    state: 'ready',
    context: followerContext,
    pendingPages: [],
  });

  const leaderOpener = { opener: async () => null };
  const leaderPopup = { opener: async () => leaderOpener };
  engine.leaderPages.set(leaderOpener, {
    followers: new Map([['follower', {
      followerId: 'follower',
      page: followerOpener,
      preassigned: null,
    }]]),
  });
  engine.leaderPages.set(leaderPopup, {
    followers: new Map(),
    popupClaimUntil: Date.now() + 500,
  });

  engine._onFollowerPage('follower', followerPopup);
  const ownershipReady = engine.followers.get('follower').pendingPages[0].ownershipReady;
  const pair = await engine._followerPair(leaderPopup, 'follower');
  await ownershipReady;

  assert.equal(followerPopupClosed, true);
  assert.equal(pair.page, deterministicPage);
  assert.equal(pair.pageSource, 'engine');
  assert.equal(engine.followers.get('follower').pendingPages.length, 0);
});

test('closes a late replay popup after a deterministic follower tab already owns the leader popup', async () => {
  const engine = new MirrorEngine();
  const followerOpener = {
    isClosed: () => false,
    url: () => 'https://store.test/',
  };
  let deterministicClosed = false;
  const deterministicPage = {
    isClosed: () => deterministicClosed,
    close: async () => { deterministicClosed = true; },
    url: () => 'https://store.test/detail',
  };
  let latePopupClosed = false;
  const latePopup = {
    isClosed: () => latePopupClosed,
    close: async () => { latePopupClosed = true; },
    opener: async () => followerOpener,
    on() {},
    url: () => 'https://feedback-pa.clients6.google.com/static/proxy.html?usegapi=1',
  };
  const follower = {
    id: 'follower',
    name: 'Follower',
    state: 'ready',
    context: {
      pages: () => [followerOpener, deterministicPage, latePopup].filter((page) => !page.isClosed()),
    },
    pendingPages: [],
  };
  engine.followers.set('follower', follower);

  const leaderOpener = { opener: async () => null };
  const leaderPopup = { opener: async () => leaderOpener };
  engine.leaderPages.set(leaderOpener, {
    followers: new Map([['follower', {
      followerId: 'follower',
      page: followerOpener,
      preassigned: null,
    }]]),
  });
  const popupPair = {
    followerId: 'follower',
    page: deterministicPage,
    preassigned: null,
    creating: null,
    pageSource: 'engine',
  };
  engine.leaderPages.set(leaderPopup, {
    followers: new Map([['follower', popupPair]]),
    createdAt: Date.now(),
  });

  engine._onFollowerPage('follower', latePopup);
  const pending = follower.pendingPages[0];
  assert.ok(pending, 'late popup was not tracked');
  await pending.ownershipReady;

  assert.equal(latePopupClosed, true);
  assert.equal(deterministicClosed, false);
  assert.equal(popupPair.page, deterministicPage);
  assert.equal(follower.pendingPages.length, 0);
});

test('does not adopt an unowned follower helper tab for a leader page without a popup opener', async () => {
  const engine = new MirrorEngine();
  let helperClosed = false;
  const followerHelper = {
    isClosed: () => helperClosed,
    close: async () => { helperClosed = true; },
    opener: async () => null,
    on() {},
    url: () => 'https://feedback-pa.clients6.google.com/static/proxy.html?usegapi=1',
  };
  let createdMirrorPage = null;
  const followerContext = {
    newPage: async () => {
      createdMirrorPage = {
        isClosed: () => false,
        bringToFront: async () => {},
        url: () => 'about:blank',
      };
      return createdMirrorPage;
    },
  };
  engine.followers.set('follower', {
    id: 'follower',
    name: 'Follower',
    state: 'ready',
    context: followerContext,
    pendingPages: [],
  });

  const leaderPage = { opener: async () => null };
  engine.leaderPages.set(leaderPage, {
    followers: new Map(),
    popupClaimUntil: Date.now() + 500,
  });

  engine._onFollowerPage('follower', followerHelper);
  const ownershipReady = engine.followers.get('follower').pendingPages[0].ownershipReady;
  const pair = await engine._followerPair(leaderPage, 'follower');
  await ownershipReady;

  assert.equal(pair.page, createdMirrorPage);
  assert.equal(helperClosed, true);
  assert.equal(engine.followers.get('follower').pendingPages.length, 0);
});

test('requeues follower navigation when a paired page drifts from the leader URL', async () => {
  const engine = new MirrorEngine();
  let currentUrl = 'https://feedback.test/static/proxy.html';
  let gotoCount = 0;
  const followerPage = {
    isClosed: () => false,
    url: () => currentUrl,
    goto: async (url) => {
      gotoCount++;
      currentUrl = url;
    },
    waitForLoadState: async () => {},
  };
  const leaderPage = {
    url: () => 'https://store.test/detail',
  };
  const pair = {
    followerId: 'follower',
    page: followerPage,
    preassigned: null,
    creating: null,
    navChain: Promise.resolve(),
    queue: [],
    queueDepth: 0,
    draining: false,
    desiredUrl: 'https://store.test/detail',
    lastNavAt: Date.now(),
  };
  engine.running = true;
  engine.mirroring = true;
  engine.followers.set('follower', {
    id: 'follower',
    name: 'Follower',
    state: 'ready',
    context: {},
  });
  engine.leaderPages.set(leaderPage, {
    followers: new Map([['follower', pair]]),
  });

  await engine._ensureFollowerUrl(leaderPage, 'follower', 'https://store.test/detail');

  assert.equal(gotoCount, 1);
  assert.equal(currentUrl, 'https://store.test/detail');
});

test('detects Google feedback proxy helpers as unsafe follower top-level URLs', () => {
  assert.equal(
    isFollowerHelperTopLevelUrl('https://feedback-pa.clients6.google.com/static/proxy.html?usegapi=1'),
    true
  );
  assert.equal(isFollowerHelperTopLevelUrl('https://chromewebstore.google.com/?hl=en'), false);
});

test('startup pruning closes unpaired restored follower tabs but keeps the assigned mirror page', async () => {
  const engine = new MirrorEngine();
  let assignedClosed = false;
  let staleClosed = false;
  const assignedPage = {
    isClosed: () => assignedClosed,
    close: async () => { assignedClosed = true; },
    url: () => 'https://chromewebstore.google.com/?hl=en',
  };
  const staleProxyPage = {
    isClosed: () => staleClosed,
    close: async () => { staleClosed = true; },
    url: () => 'https://feedback-pa.clients6.google.com/static/proxy.html?usegapi=1',
  };
  const context = {
    pages: () => [assignedPage, staleProxyPage].filter((page) => !page.isClosed()),
  };
  const follower = {
    id: 'follower',
    name: 'Follower',
    state: 'ready',
    context,
    pendingPages: [],
  };
  const leaderPage = {};
  engine.followers.set('follower', follower);
  engine.leaderPages.set(leaderPage, {
    followers: new Map([['follower', {
      followerId: 'follower',
      page: assignedPage,
      preassigned: null,
    }]]),
  });

  await engine._pruneFollowerPages(follower, 'startup');

  assert.equal(assignedClosed, false);
  assert.equal(staleClosed, true);
});

test('runtime pruning immediately closes an unpaired helper page', async () => {
  const engine = new MirrorEngine();
  engine.running = true;
  let assignedClosed = false;
  let helperClosed = false;
  const assignedPage = {
    isClosed: () => assignedClosed,
    close: async () => { assignedClosed = true; },
    url: () => 'https://chromewebstore.google.com/?hl=en',
  };
  const helperPage = {
    isClosed: () => helperClosed,
    close: async () => { helperClosed = true; },
    url: () => 'https://feedback-pa.clients6.google.com/static/proxy.html?usegapi=1',
  };
  const context = {
    pages: () => [assignedPage, helperPage].filter((page) => !page.isClosed()),
  };
  const follower = {
    id: 'follower',
    name: 'Follower',
    state: 'ready',
    context,
    pendingPages: [{ page: helperPage, createdAt: Date.now(), openerReady: Promise.resolve(null) }],
  };
  const leaderPage = {};
  engine.followers.set('follower', follower);
  engine.leaderPages.set(leaderPage, {
    followers: new Map([['follower', {
      followerId: 'follower',
      page: assignedPage,
      preassigned: null,
    }]]),
  });

  await engine._pruneFollowerPages(follower, 'runtime');
  assert.equal(helperClosed, true);
  assert.equal(assignedClosed, false);
});
