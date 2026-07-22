'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const TARGET_URL = 'https://chromewebstore.google.com/?hl=en';
const WAIT_TIMEOUT_MS = 30_000;
const SEARCH_TEXT = 'adobe photoshop';
const HEADED = process.argv.includes('--headed');

function packagedAsarPath() {
  const index = process.argv.indexOf('--asar');
  if (index === -1) return null;
  const value = process.argv[index + 1];
  assert.ok(value, '--asar requires a path');
  return path.resolve(value);
}

function loadMirrorEngine(root, asarPath) {
  if (!asarPath) {
    return {
      MirrorEngine: require('../src/main/mirror-engine').MirrorEngine,
      build: 'source',
    };
  }

  assert.ok(fs.existsSync(asarPath), `packaged ASAR was not found: ${asarPath}`);
  const asar = require('@electron/asar');
  const mainDir = path.join(root, 'packaged-main');
  fs.mkdirSync(mainDir, { recursive: true });

  for (const file of ['capture-script.js', 'mirror-engine.js', 'profile-hygiene.js', 'replay.js']) {
    const archivePath = path.join('build-app', 'main', file);
    fs.writeFileSync(path.join(mainDir, file), asar.extractFile(asarPath, archivePath));
  }

  process.env.NODE_PATH = [
    path.join(__dirname, '..', 'node_modules'),
    process.env.NODE_PATH,
  ].filter(Boolean).join(path.delimiter);
  Module._initPaths();

  return {
    MirrorEngine: require(path.join(mainDir, 'mirror-engine.js')).MirrorEngine,
    build: 'packaged',
  };
}

function findChrome() {
  const candidates = [
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    process.env['PROGRAMFILES(X86)']
      && path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
    process.env.LOCALAPPDATA
      && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function waitFor(check, message, pollMs = 50) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await check();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`${message}; last value: ${JSON.stringify(lastValue)}`);
}

function searchBoxLocator(page) {
  return page.locator(
    'input[aria-label*="Search" i], input[placeholder*="Search" i], textarea[aria-label*="Search" i], textarea[placeholder*="Search" i]'
  ).first();
}

async function searchBoxValue(page) {
  return searchBoxLocator(page).evaluate((element) => element.value || '').catch(() => '');
}

async function main() {
  const chrome = findChrome();
  assert.ok(chrome, 'Google Chrome is required for the real Chrome Web Store mirror test');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-mirror-cws-'));
  const loaded = loadMirrorEngine(root, packagedAsarPath());
  const { MirrorEngine } = loaded;
  const leaderDir = path.join(root, 'leader');
  const followerDir = path.join(root, 'follower');
  fs.mkdirSync(leaderDir, { recursive: true });
  fs.mkdirSync(followerDir, { recursive: true });
  const dirtySessionsDir = path.join(followerDir, 'Default', 'Sessions');
  fs.mkdirSync(dirtySessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(dirtySessionsDir, 'Session_dirty'),
    'https://feedback-pa.clients6.google.com/static/proxy.html?usegapi=1'
  );

  const engine = new MirrorEngine();

  try {
    await engine.start({
      leaderProfile: { id: 'leader', name: 'Leader', dir: leaderDir },
      followerProfiles: [{ id: 'follower', name: 'Follower', dir: followerDir }],
      settings: { coordFallback: true, syncFullFieldValues: false },
      executablePath: chrome,
      headless: !HEADED,
      leaderArgs: HEADED ? [] : ['--no-sandbox'],
      followerArgs: new Map([['follower', HEADED ? [] : ['--no-sandbox']]]),
      displays: [],
    });

    assert.equal(
      fs.existsSync(path.join(dirtySessionsDir, 'Session_dirty')),
      false,
      'dirty follower Default\\Sessions file was not removed before Chrome launch'
    );

    const initialLeaderPage = engine.activeLeaderPage;
    assert.ok(initialLeaderPage, 'leader page was not created');
    const followerContext = engine.followers.get('follower').context;
    const topLevelProxyNavigations = [];
    const observeFollowerPage = (page) => {
      const record = (frame) => {
        const isMainFrame = typeof page.mainFrame !== 'function' || frame === page.mainFrame();
        if (isMainFrame && page.url().includes('feedback-pa.clients6.google.com/static/proxy.html')) {
          topLevelProxyNavigations.push(page.url());
        }
      };
      if (typeof page.on === 'function') page.on('framenavigated', record);
      if (page.url().includes('feedback-pa.clients6.google.com/static/proxy.html')) {
        topLevelProxyNavigations.push(page.url());
      }
    };
    for (const page of followerContext.pages()) observeFollowerPage(page);
    followerContext.on('page', observeFollowerPage);

    // Match the real failing layout: keep the onboarding tab, create one spare
    // normal tab, then use a third tab for Chrome Web Store.
    const spareLeaderPage = await engine.leaderCtx.newPage();
    await waitFor(() => {
      const state = engine.leaderPages.get(spareLeaderPage);
      const pair = state && state.followers.get('follower');
      return pair && pair.page;
    }, 'spare leader tab was not paired');
    const leaderPage = await engine.leaderCtx.newPage();
    const followerPage = await waitFor(() => {
      const state = engine.leaderPages.get(leaderPage);
      const pair = state && state.followers.get('follower');
      return pair && pair.page;
    }, 'Chrome Web Store leader tab was not paired');

    const navigationStartedAt = Date.now();
    let followerNavigationObservedAt = 0;
    const followerNavigation = waitFor(
      () => /^https:\/\/chromewebstore\.google\.com\/(\?|$)/.test(followerPage.url()),
      'Chrome Web Store top-level navigation did not reach follower'
    ).then((value) => {
      followerNavigationObservedAt = Date.now();
      return value;
    });
    await leaderPage.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await followerNavigation;
    const chromeWebStoreNavigationMirrorMs = followerNavigationObservedAt - navigationStartedAt;

    await waitFor(
      () => leaderPage.frames().some((frame) => frame.url().includes('feedback-pa.clients6.google.com/static/proxy.html')),
      'leader Chrome Web Store feedback proxy frame did not appear'
    ).catch(() => false);

    await new Promise((resolve) => setTimeout(resolve, 4000));

    assert.equal(
      followerPage.url().includes('feedback-pa.clients6.google.com/static/proxy.html'),
      false,
      'real Chrome Web Store proxy iframe became the follower top-level page'
    );
    assert.equal(
      /^https:\/\/chromewebstore\.google\.com\/(\?|$)/.test(followerPage.url()),
      true,
      'follower left the Chrome Web Store top-level page'
    );

    const leaderSearch = searchBoxLocator(leaderPage);
    await leaderSearch.waitFor({ state: 'visible', timeout: 15_000 });
    const searchStartedAt = Date.now();
    await leaderSearch.click({ timeout: 5000 });
    await leaderPage.keyboard.insertText(SEARCH_TEXT);

    await waitFor(
      async () => (await searchBoxValue(followerPage)).toLowerCase().includes(SEARCH_TEXT),
      'Chrome Web Store search text did not mirror into the follower'
    );
    const searchInputMirrorMs = Date.now() - searchStartedAt;
    await new Promise((resolve) => setTimeout(resolve, 3000));

    assert.equal(
      followerPage.url().includes('feedback-pa.clients6.google.com/static/proxy.html'),
      false,
      'Chrome Web Store search interaction moved the follower top-level page to the feedback proxy'
    );
    assert.equal(
      /^https:\/\/chromewebstore\.google\.com\/(\?|$)/.test(followerPage.url()),
      true,
      'follower left Chrome Web Store after search interaction'
    );
    assert.deepEqual(
      topLevelProxyNavigations,
      [],
      'Chrome Web Store helper iframe was promoted to a follower top-level navigation'
    );

    const photoshopSuggestion = leaderPage.getByRole('option', { name: 'Adobe Photoshop Extension' });
    await photoshopSuggestion.waitFor({ state: 'visible', timeout: 15_000 });
    const detailClickStartedAt = Date.now();
    await photoshopSuggestion.click({ timeout: 5000 });

    const detailLeaderPage = await waitFor(
      () => engine.leaderCtx.pages().find((page) => /\/detail\/adobe-photoshop\//.test(page.url())),
      'clicking the real Adobe Photoshop result did not open its detail page'
    );
    const detailFollowerPage = await waitFor(() => {
      const state = engine.leaderPages.get(detailLeaderPage);
      const pair = state && state.followers.get('follower');
      return pair && pair.page && /\/detail\/adobe-photoshop\//.test(pair.page.url())
        ? pair.page
        : null;
    }, 'Adobe Photoshop detail page was not paired to the follower');
    const detailTabMirrorMs = Date.now() - detailClickStartedAt;

    await new Promise((resolve) => setTimeout(resolve, 4000));
    assert.equal(
      followerContext.pages().some((page) => page.url().includes('feedback-pa.clients6.google.com/static/proxy.html')),
      false,
      'real Chrome Web Store result click left a feedback proxy as a follower top-level tab'
    );
    assert.equal(
      followerContext.pages().length,
      engine.leaderCtx.pages().length,
      'real Chrome Web Store result click broke 1:1 tab ownership'
    );
    assert.deepEqual(
      topLevelProxyNavigations,
      [],
      'real Chrome Web Store interaction attempted a feedback proxy top-level navigation'
    );
    const visibleFollowerPages = [];
    for (const page of followerContext.pages()) {
      const visibility = await page.evaluate(() => document.visibilityState).catch(() => 'unknown');
      if (visibility === 'visible') visibleFollowerPages.push(page);
    }
    assert.equal(
      visibleFollowerPages.includes(detailFollowerPage),
      true,
      'the intended follower detail tab was not the active visible tab'
    );

    console.log(JSON.stringify({
      ok: true,
      build: loaded.build,
      targetUrl: TARGET_URL,
      leaderUrl: leaderPage.url(),
      followerUrl: followerPage.url(),
      searchTextMirrored: true,
      detailClickMirrored: true,
      detailLeaderUrl: detailLeaderPage.url(),
      detailFollowerUrl: detailFollowerPage.url(),
      followerStayedTopLevelChromeWebStore: true,
      proxyDidNotBecomeTopLevel: true,
      proxyTopLevelNavigationAttempts: topLevelProxyNavigations.length,
      intendedFollowerTabVisible: true,
      chromeWebStoreNavigationMirrorMs,
      searchInputMirrorMs,
      detailTabMirrorMs,
      headed: HEADED,
      dirtySessionRestoreBackedUp: true,
      leaderTabs: engine.leaderCtx.pages().length,
      followerTabs: followerContext.pages().length,
    }, null, 2));
  } finally {
    await engine.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
