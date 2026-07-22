'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { MirrorEngine } = require('../src/main/mirror-engine');

const STORE_URL = 'https://chromewebstore.google.com/?hl=en';
const PROXY_URL =
  'https://feedback-pa.clients6.google.com/static/proxy.html?usegapi=1';

function fakePage(url, options = {}) {
  let currentUrl = url;
  let closed = false;
  let frontCount = 0;
  const listeners = new Map();

  const page = {
    isClosed: () => closed,
    url: () => currentUrl,
    opener: async () => options.opener || null,
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(listener);
    },
    emit(name, value) {
      for (const listener of listeners.get(name) || []) listener(value);
    },
    async close() {
      closed = true;
      for (const listener of listeners.get('close') || []) listener();
    },
    async bringToFront() {
      frontCount++;
    },
    async goto(nextUrl) {
      if (options.gotoError) throw options.gotoError;
      currentUrl = nextUrl;
    },
    async waitForLoadState() {},
    mainFrame: () => page,
    frames: () => [page],
    evaluate: async () => true,
    get frontCount() {
      return frontCount;
    },
  };

  return page;
}

function fakeNavigationRequest(page, url, options = {}) {
  return {
    isNavigationRequest: () => true,
    frame: () => page.mainFrame(),
    method: () => options.method || 'GET',
    redirectedFrom: () => options.redirectedFrom || null,
    url: () => url,
  };
}

function leaderState(overrides = {}) {
  return {
    tracked: true,
    followers: new Map(),
    inputDebounce: new Map(),
    desiredUrl: null,
    suppressNavUntil: 0,
    popupClaimUntil: Date.now() + 1500,
    createdAt: Date.now(),
    ...overrides,
  };
}

function pendingEntry(page, opener) {
  return {
    page,
    opener: opener || null,
    createdAt: Date.now(),
    openerReady: Promise.resolve(opener || null),
  };
}

test('an early feedback proxy is quarantined instead of being adopted for a leader popup', async () => {
  const engine = new MirrorEngine();
  const followerOpener = fakePage('https://chromewebstore.google.com/');
  const proxy = fakePage(PROXY_URL, { opener: followerOpener });
  const canonical = fakePage('about:blank');
  let newPageCount = 0;
  let canonicalCreated = false;

  const follower = {
    id: 'follower',
    name: 'Follower',
    state: 'ready',
    pendingPages: [],
    context: {
      pages: () => [
        followerOpener,
        proxy,
        canonicalCreated ? canonical : null,
      ].filter((page) => page && !page.isClosed()),
      newPage: async () => {
        newPageCount++;
        canonicalCreated = true;
        return canonical;
      },
    },
  };
  engine.followers.set('follower', follower);

  const leaderOpener = fakePage('https://chromewebstore.google.com/');
  const leaderPopup = fakePage('https://chromewebstore.google.com/detail/example', {
    opener: leaderOpener,
  });
  engine.leaderPages.set(
    leaderOpener,
    leaderState({
      followers: new Map([
        ['follower', {
          followerId: 'follower',
          page: followerOpener,
          preassigned: null,
        }],
      ]),
    })
  );
  engine.leaderPages.set(leaderPopup, leaderState());
  engine.activeLeaderPage = leaderPopup;

  // The helper appears inside the old 1500ms popup-claim window. Start pair
  // creation immediately, without waiting for its ownership task to settle.
  engine._onFollowerPage('follower', proxy);
  const ownershipReady = follower.pendingPages[0].ownershipReady;
  const pair = await engine._followerPair(leaderPopup, 'follower');
  await ownershipReady;

  assert.equal(proxy.isClosed(), true, 'the known helper must be closed immediately');
  assert.equal(newPageCount, 1, 'the engine must create one deterministic follower tab');
  assert.equal(pair.page, canonical, 'the deterministic tab must own the leader popup');
  assert.equal(pair.pageSource, 'engine');
  assert.equal(follower.pendingPages.length, 0);
});

test('an unowned follower page is quarantined immediately without a grace-period foreground', async () => {
  const engine = new MirrorEngine();
  const canonical = fakePage(STORE_URL);
  const rogue = fakePage('https://unowned.example/popup');
  const follower = {
    id: 'follower',
    name: 'Follower',
    state: 'ready',
    pendingPages: [pendingEntry(rogue, null)],
    context: {
      pages: () => [canonical, rogue].filter((page) => !page.isClosed()),
    },
  };
  const leaderPage = fakePage(STORE_URL);
  const state = leaderState({
    followers: new Map([
      ['follower', {
        followerId: 'follower',
        page: canonical,
        preassigned: null,
      }],
    ]),
  });
  engine.followers.set('follower', follower);
  engine.leaderPages.set(leaderPage, state);
  engine.activeLeaderPage = leaderPage;

  await engine._pruneFollowerPages(follower, 'runtime');

  assert.equal(rogue.isClosed(), true, 'unowned pages must not remain visible for 2200ms');
  assert.equal(
    canonical.frontCount > 0,
    true,
    'the canonical follower page must be restored to the foreground'
  );
  assert.equal(follower.pendingPages.length, 0);
});

test('the exact page returned by context.newPage remains the canonical pair', async () => {
  const engine = new MirrorEngine();
  const canonical = fakePage('about:blank');
  let canonicalCreated = false;
  const follower = {
    id: 'follower',
    name: 'Follower',
    state: 'ready',
    pendingPages: [],
    context: {
      pages: () => canonicalCreated && !canonical.isClosed() ? [canonical] : [],
      newPage: async () => {
        canonicalCreated = true;
        // Playwright emits context.on('page') before newPage() resolves. An
        // immediate quarantine policy must distinguish this reserved page from
        // an unowned web-created popup.
        engine._onFollowerPage('follower', canonical);
        await Promise.resolve();
        return canonical;
      },
    },
  };
  engine.followers.set('follower', follower);

  const leaderPage = fakePage(STORE_URL);
  engine.leaderPages.set(
    leaderPage,
    leaderState({ popupClaimUntil: Date.now() - 1 })
  );
  engine.activeLeaderPage = leaderPage;

  const pair = await engine._followerPair(leaderPage, 'follower');

  assert.equal(pair.page, canonical);
  assert.equal(pair.pageSource, 'engine');
  assert.equal(canonical.isClosed(), false, 'the engine-created page must not quarantine itself');
  assert.equal(follower.pendingPages.length, 0);

  // Prevent the legacy delayed-prune timer installed by _onFollowerPage from
  // doing work after this focused ownership assertion.
  engine.running = false;
});

test('creating a blank follower tab does not steal foreground before navigation commits', async () => {
  const engine = new MirrorEngine();
  const canonical = fakePage('about:blank');
  const follower = {
    id: 'follower',
    name: 'Follower',
    state: 'ready',
    pendingPages: [],
    context: {
      pages: () => [canonical].filter((page) => !page.isClosed()),
      newPage: async () => canonical,
    },
  };
  engine.followers.set('follower', follower);

  const leaderPage = fakePage(STORE_URL);
  engine.leaderPages.set(leaderPage, leaderState());
  engine.activeLeaderPage = leaderPage;

  const pair = await engine._followerPair(leaderPage, 'follower');

  assert.equal(pair.page, canonical);
  assert.equal(canonical.frontCount, 0, 'blank engine-created tabs must not become visible');
});

test('a committed follower tab becomes visible before a slow DOMContentLoaded', async () => {
  const engine = new MirrorEngine();
  engine.running = true;
  engine.mirroring = true;

  let releaseDomReady;
  const domReady = new Promise((resolve) => { releaseDomReady = resolve; });
  const canonical = fakePage('about:blank');
  canonical.waitForLoadState = () => domReady;
  const follower = {
    id: 'follower',
    name: 'Follower',
    state: 'ready',
    queueDepth: 0,
    pendingPages: [],
    ownedPages: new Set([canonical]),
    guardedPages: new Set(),
    ownedPageCreations: new Set(),
    recoveringPages: new Set(),
    context: { pages: () => [canonical] },
  };
  engine.followers.set('follower', follower);

  const leaderPage = fakePage(STORE_URL);
  const state = leaderState();
  const pair = engine._ensurePair(state, 'follower');
  pair.page = canonical;
  pair.pageSource = 'engine';
  engine.leaderPages.set(leaderPage, state);
  engine.activeLeaderPage = leaderPage;

  const navigation = engine._ensureFollowerUrl(leaderPage, 'follower', STORE_URL);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(canonical.url(), STORE_URL, 'the correct URL must be committed first');
  assert.equal(canonical.frontCount, 1, 'the committed tab must be shown without waiting for DOM ready');

  releaseDomReady();
  await navigation;
  engine.running = false;
});

test('browser-UI GET navigation starts follower loading before leader commit', () => {
  const engine = new MirrorEngine();
  engine.running = true;
  engine.mirroring = true;
  const leaderPage = fakePage('https://example.com/old');
  const mirroredUrls = [];
  engine._syncNav = (_page, url) => {
    mirroredUrls.push(url);
    return Promise.resolve();
  };

  engine._trackLeaderPage(leaderPage);
  const request = fakeNavigationRequest(leaderPage, STORE_URL);
  leaderPage.emit('request', request);

  assert.deepEqual(mirroredUrls, [STORE_URL]);
  assert.equal(engine.leaderPages.get(leaderPage).speculativeNavigation.request, request);
});

test('captured page interaction prevents duplicate speculative navigation', () => {
  const engine = new MirrorEngine();
  engine.running = true;
  engine.mirroring = true;
  const leaderPage = fakePage('https://example.com/old');
  const mirroredUrls = [];
  engine._syncNav = (_page, url) => {
    mirroredUrls.push(url);
    return Promise.resolve();
  };

  engine._trackLeaderPage(leaderPage);
  engine.leaderPages.get(leaderPage).lastPageInteractionAt = Date.now();
  leaderPage.emit('request', fakeNavigationRequest(leaderPage, STORE_URL));

  assert.deepEqual(mirroredUrls, [], 'the trusted click replay must remain the only navigation owner');
});

test('failed speculative navigation restores follower accuracy', () => {
  const engine = new MirrorEngine();
  engine.running = true;
  engine.mirroring = true;
  const previousUrl = 'https://example.com/old';
  const leaderPage = fakePage(previousUrl);
  const mirroredUrls = [];
  engine._syncNav = (_page, url) => {
    mirroredUrls.push(url);
    return Promise.resolve();
  };

  engine._trackLeaderPage(leaderPage);
  const request = fakeNavigationRequest(leaderPage, STORE_URL);
  leaderPage.emit('request', request);
  leaderPage.emit('requestfailed', request);

  assert.deepEqual(mirroredUrls, [STORE_URL, previousUrl]);
  assert.equal(engine.leaderPages.get(leaderPage).speculativeNavigation, null);
});

test('background navigation does not steal active-tab ownership', () => {
  const engine = new MirrorEngine();
  engine.running = true;
  engine.mirroring = true;
  const activePage = fakePage('https://example.com/active');
  const backgroundPage = fakePage('https://example.com/background');
  engine._syncNav = () => Promise.resolve();

  engine._trackLeaderPage(activePage);
  engine._trackLeaderPage(backgroundPage);
  engine.activeLeaderPage = activePage;
  backgroundPage.emit('framenavigated', backgroundPage.mainFrame());

  assert.equal(engine.activeLeaderPage, activePage);
});

test('returning to a previous leader tab foregrounds its exact follower pair', async () => {
  const engine = new MirrorEngine();
  engine.running = true;
  engine.mirroring = true;
  const firstLeader = fakePage('https://example.com/first');
  const secondLeader = fakePage('https://example.com/second');
  const firstFollower = fakePage('https://example.com/first');
  const secondFollower = fakePage('https://example.com/second');
  const follower = {
    id: 'follower',
    name: 'Follower',
    state: 'ready',
    queueDepth: 0,
    pendingPages: [],
    ownedPages: new Set([firstFollower, secondFollower]),
    guardedPages: new Set(),
    ownedPageCreations: new Set(),
    recoveringPages: new Set(),
    context: { pages: () => [firstFollower, secondFollower] },
  };
  engine.followers.set('follower', follower);
  engine._trackLeaderPage(firstLeader);
  engine._trackLeaderPage(secondLeader);
  const firstPair = engine._ensurePair(engine.leaderPages.get(firstLeader), 'follower');
  firstPair.page = firstFollower;
  const secondPair = engine._ensurePair(engine.leaderPages.get(secondLeader), 'follower');
  secondPair.page = secondFollower;
  engine.activeLeaderPage = secondLeader;

  engine._onEvent(
    firstLeader,
    JSON.stringify({ kind: 'tab-activate', ts: Date.now() }),
    firstLeader.mainFrame()
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(engine.activeLeaderPage, firstLeader);
  assert.equal(firstFollower.frontCount, 1);
  assert.equal(secondFollower.frontCount, 0);
});

test('reconcile does not repeatedly force navigation on an already-owned follower tab', async () => {
  const engine = new MirrorEngine();
  engine.running = true;
  engine.mirroring = true;

  let gotoCount = 0;
  const followerPage = fakePage('about:blank');
  followerPage.goto = async (url) => {
    gotoCount++;
    throw new Error(`unexpected reconcile navigation to ${url}`);
  };

  const follower = {
    id: 'follower',
    name: 'Follower',
    state: 'ready',
    queueDepth: 0,
    lastError: null,
    pendingPages: [],
    ownedPages: new Set([followerPage]),
    guardedPages: new Set(),
    ownedPageCreations: new Set(),
    recoveringPages: new Set(),
    context: {
      pages: () => [followerPage].filter((page) => !page.isClosed()),
    },
  };
  engine.followers.set('follower', follower);

  const leaderPage = fakePage(STORE_URL);
  const state = leaderState();
  const pair = engine._ensurePair(state, 'follower');
  pair.page = followerPage;
  pair.pageSource = 'engine';
  pair.desiredUrl = STORE_URL;
  pair.navChain = Promise.resolve();
  engine.leaderPages.set(leaderPage, state);
  engine.leaderCtx = { pages: () => [leaderPage] };
  engine.activeLeaderPage = leaderPage;

  await engine._reconcile();
  await engine._reconcile();

  assert.equal(gotoCount, 0, 'reconcile must not refresh an owned tab on every poll');
  engine.running = false;
});

test('an assigned page that becomes a feedback proxy is replaced and resynced', async () => {
  const engine = new MirrorEngine();
  engine.running = true;
  engine.mirroring = true;

  const brokenProxy = fakePage(PROXY_URL, {
    gotoError: new Error('net::ERR_ABORTED while leaving helper page'),
  });
  const replacement = fakePage('about:blank');
  let newPageCount = 0;
  let replacementCreated = false;
  const follower = {
    id: 'follower',
    name: 'Follower',
    state: 'ready',
    queueDepth: 0,
    lastError: null,
    pendingPages: [],
    ownedPages: new Set([brokenProxy]),
    guardedPages: new Set(),
    ownedPageCreations: new Set(),
    recoveringPages: new Set(),
    context: {
      pages: () => [
        brokenProxy,
        replacementCreated ? replacement : null,
      ].filter((page) => page && !page.isClosed()),
      newPage: async () => {
        newPageCount++;
        replacementCreated = true;
        return replacement;
      },
    },
  };
  engine.followers.set('follower', follower);

  const leaderPage = fakePage(STORE_URL);
  const state = leaderState();
  const pair = engine._ensurePair(state, 'follower');
  pair.page = brokenProxy;
  pair.pageSource = 'engine';
  pair.desiredUrl = STORE_URL;
  engine.leaderPages.set(leaderPage, state);
  engine.leaderCtx = { pages: () => [leaderPage] };
  engine.activeLeaderPage = leaderPage;

  await engine._reconcile();

  const repairedPair = state.followers.get('follower');
  assert.equal(brokenProxy.isClosed(), true, 'an assigned helper page must be discarded');
  assert.equal(newPageCount, 1, 'one replacement page must be created');
  assert.equal(repairedPair.page, replacement, 'the replacement must become the canonical pair');
  assert.equal(replacement.url(), STORE_URL, 'the replacement must be synced to the leader URL');
  assert.equal(
    follower.context.pages().some((page) => page.url().startsWith(PROXY_URL)),
    false
  );

  engine.running = false;
});
