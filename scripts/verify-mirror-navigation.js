'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const WAIT_TIMEOUT_MS = 12_000;

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
    fs.writeFileSync(
      path.join(mainDir, file),
      asar.extractFile(asarPath, archivePath)
    );
  }

  // The extracted main files still load the packaged runtime dependency.
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

function testPage(proxyUrl) {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Mirror navigation test</title></head>
  <body>
    <h1 id="page-title">Leader main page</h1>
    <a id="open-detail" href="/detail" target="_blank">Open detail</a>
    <iframe
      id="feedback-proxy"
      src="${proxyUrl}/static/proxy.html?usegapi=1"
      title="Google-style feedback proxy"
    ></iframe>
    <script>
      document.getElementById('open-detail').addEventListener('click', function (event) {
        event.preventDefault();
        // Reproduce the exact race: the leader opens the requested detail tab,
        // while the replayed follower click immediately opens a helper popup.
        // The helper must never become the canonical follower tab.
        if (window.__mirrorBadge) {
          fetch('/follower-popup-fired', { method: 'POST', keepalive: true }).catch(function () {});
          window.open(
            '${proxyUrl}/static/proxy.html?usegapi=1&opened-by=follower',
            '_blank'
          );
          return;
        }
        window.open('/detail', '_blank');
      });
    </script>
  </body>
</html>`;
}

function detailPage(proxyUrl) {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Mirror detail page</title></head>
  <body>
    <h1 id="detail-title">Mirrored detail page</h1>
    <label for="recovery-input">Recovery typing test</label>
    <input id="recovery-input" autocomplete="off">
    <script>document.addEventListener('input', function (event) { window.__lastInputTrusted = event.isTrusted; }, true);</script>
    <iframe
      id="detail-feedback-proxy"
      src="${proxyUrl}/static/proxy.html?usegapi=1&inside=detail"
      title="Detail feedback proxy"
    ></iframe>
  </body>
</html>`;
}

function proxyPage() {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Feedback proxy</title></head>
  <body><p>Embedded proxy frame</p></body>
</html>`;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function waitFor(check, message) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await check();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${message}; last value: ${JSON.stringify(lastValue)}`);
}

async function main() {
  const chrome = findChrome();
  assert.ok(chrome, 'Google Chrome is required for the real-browser mirror test');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-mirror-nav-'));
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

  const proxyUrl = 'https://feedback-pa.clients6.google.com';
  let followerPopupTriggers = 0;

  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/follower-popup-fired')) {
      followerPopupTriggers++;
      response.statusCode = 204;
      response.end();
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(request.url.startsWith('/detail') ? detailPage(proxyUrl) : testPage(proxyUrl));
  });

  const baseUrl = await listen(server);
  const runtimeLogs = [];
  const engine = new MirrorEngine({ onLog: (entry) => runtimeLogs.push(entry) });

  try {
    await engine.start({
      leaderProfile: { id: 'leader', name: 'Leader', dir: leaderDir },
      followerProfiles: [{ id: 'follower', name: 'Follower', dir: followerDir }],
      settings: {},
      executablePath: chrome,
      headless: true,
      leaderArgs: ['--no-sandbox'],
      followerArgs: new Map([['follower', ['--no-sandbox']]]),
      displays: [],
    });

    assert.equal(
      fs.existsSync(path.join(dirtySessionsDir, 'Session_dirty')),
      false,
      'dirty follower Default\\Sessions file was not removed before Chrome launch'
    );
    assert.equal(
      fs.readdirSync(path.join(root, '.session-backups'), { recursive: true })
        .some((entry) => String(entry).endsWith(path.join('Default', 'Sessions', 'Session_dirty'))),
      true,
      'dirty follower session file was not backed up before cleanup'
    );

    const leaderPage = engine.activeLeaderPage;
    assert.ok(leaderPage, 'leader page was not created');
    let followerPage = await waitFor(
      () => engine.followerPage,
      'follower page was not created'
    );
    const follower = engine.followers.get('follower');
    assert.ok(follower && follower.context, 'follower context was not available');
    await engine.leaderCtx.route(`${proxyUrl}/**`, (route) => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: proxyPage(),
    }));
    await follower.context.route(`${proxyUrl}/**`, (route) => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: proxyPage(),
    }));

    const unsafeAssignedPage = followerPage;
    await unsafeAssignedPage.goto(`${proxyUrl}/static/proxy.html?usegapi=1&restored=stale`, {
      waitUntil: 'domcontentloaded',
    }).catch(() => {});
    followerPage = await waitFor(
      () => {
        const current = engine.followerPage;
        return current
          && current !== unsafeAssignedPage
          && !current.isClosed()
          && unsafeAssignedPage.isClosed()
          ? current
          : null;
      },
      'an assigned feedback helper page was not replaced'
    );
    assert.equal(unsafeAssignedPage.isClosed(), true, 'unsafe assigned helper tab remained open');

    await leaderPage.goto(`${baseUrl}/store`, { waitUntil: 'domcontentloaded' });

    await waitFor(
      () => followerPage.url() === `${baseUrl}/store`,
      'initial main-frame navigation did not recover a stale follower proxy page'
    );

    const childFrame = await waitFor(
      () => leaderPage.frames().find((frame) => frame.url().includes('/static/proxy.html')),
      'leader proxy iframe did not load'
    );
    await childFrame.evaluate(() => {
      history.pushState(null, '', '/static/proxy.html?usegapi=1&after=1');
    });
    await new Promise((resolve) => setTimeout(resolve, 700));

    assert.equal(
      followerPage.url(),
      `${baseUrl}/store`,
      'child-frame SPA navigation replaced the follower top-level page'
    );

    await leaderPage.evaluate(() => {
      history.pushState(null, '', '/next');
    });
    await waitFor(
      () => followerPage.url() === `${baseUrl}/next`,
      'main-frame SPA navigation did not reach the follower'
    );

    await waitFor(
      () => followerPage.evaluate(() => window.__mirrorBadge === true).catch(() => false),
      'follower badge/init script was not ready before popup replay'
    );
    assert.equal(
      await followerPage.evaluate(
        () => document.getElementById('__cm_badge')?.textContent === '● OFFICIAL MIRROR'
      ),
      true,
      'follower did not show the official main-app ownership badge'
    );

    const leaderPageCountBeforePopup = engine.leaderCtx.pages().length;
    const followerPageEvents = [];
    follower.context.on('page', (page) => followerPageEvents.push(page));
    const followerPageCountBeforePopup = follower.context.pages().length;

    await leaderPage.click('#open-detail');

    await waitFor(
      () => followerPopupTriggers > 0,
      'the follower replay branch did not exercise the popup guard'
    );

    const leaderDetailPage = await waitFor(
      () => engine.leaderCtx.pages().find((page) => page.url() === `${baseUrl}/detail`),
      'leader detail popup did not open'
    );
    const followerDetailPage = await waitFor(() => {
      const state = engine.leaderPages.get(leaderDetailPage);
      const pair = state && state.followers.get('follower');
      return pair && pair.page && pair.page.url() === `${baseUrl}/detail` ? pair.page : null;
    }, 'leader detail popup was not paired to the intended follower detail page');

    await new Promise((resolve) => setTimeout(resolve, 1200));

    assert.equal(
      engine.leaderCtx.pages().length,
      leaderPageCountBeforePopup + 1,
      'leader popup test created an unexpected number of tabs'
    );
    assert.equal(
      follower.context.pages().length,
      followerPageCountBeforePopup + 1,
      'follower retained a duplicate or unowned popup tab'
    );
    assert.equal(
      followerPageEvents.length,
      1,
      'follower web content created an extra top-level tab instead of letting the engine own tab creation'
    );
    assert.equal(
      followerPageEvents[0],
      followerDetailPage,
      'the only follower tab created for the leader popup must be the engine-owned paired tab'
    );
    assert.equal(
      follower.context.pages().some((page) => page.url().startsWith(proxyUrl)),
      false,
      'Google-style proxy popup remained as a follower top-level tab'
    );

    // Switching back to an older leader tab must foreground its exact paired
    // follower tab; switching forward must restore the detail pair again.
    await leaderPage.bringToFront();
    await waitFor(
      () => followerPage.evaluate(() => document.visibilityState === 'visible').catch(() => false),
      'returning to the previous leader tab did not foreground its follower pair'
    );
    await leaderDetailPage.bringToFront();
    await waitFor(
      () => followerDetailPage.evaluate(() => document.visibilityState === 'visible').catch(() => false),
      'returning to the detail leader tab did not foreground its follower pair'
    );

    // Continuous stability matters: the old test could pass before its delayed
    // popup fired. Keep checking beyond the former 2200 ms grace period.
    const stableUntil = Date.now() + 3500;
    while (Date.now() < stableUntil) {
      const detailState = engine.leaderPages.get(leaderDetailPage);
      const detailPair = detailState && detailState.followers.get('follower');
      assert.equal(detailPair && detailPair.page, followerDetailPage);
      assert.equal(followerDetailPage.url(), `${baseUrl}/detail`);
      assert.equal(follower.context.pages().length, followerPageCountBeforePopup + 1);
      assert.equal(
        follower.context.pages().some((page) => isFeedbackProxyUrl(page.url())),
        false,
        'feedback proxy became a follower top-level tab during the stability window'
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const detailChildFrame = await waitFor(
      () => followerDetailPage.frames().find((frame) => frame.url().includes('/static/proxy.html')),
      'follower detail proxy iframe did not load'
    );
    assert.ok(detailChildFrame, 'follower detail proxy iframe was not found');

    const leaderDetailChildFrame = await waitFor(
      () => leaderDetailPage.frames().find((frame) => frame.url().includes('/static/proxy.html')),
      'leader detail proxy iframe did not load'
    );
    await leaderDetailChildFrame.evaluate(() => {
      history.pushState(null, '', '/static/proxy.html?usegapi=1&inside=detail&after=1');
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(
      followerDetailPage.url(),
      `${baseUrl}/detail`,
      'detail child-frame navigation replaced the paired follower top-level page'
    );

    const oldFollowerContext = follower.context;
    await oldFollowerContext.close();
    const recoveredFollower = await waitFor(() => {
      const current = engine.followers.get('follower');
      return current && current.state === 'ready' && current.context && current.context !== oldFollowerContext
        ? current
        : null;
    }, 'follower context did not recover automatically after an unexpected close');
    const recoveredDetailPage = await waitFor(() => {
      const detailState = engine.leaderPages.get(leaderDetailPage);
      const detailPair = detailState && detailState.followers.get('follower');
      return detailPair && detailPair.page && detailPair.page.url() === `${baseUrl}/detail`
        ? detailPair.page
        : null;
    }, 'recovered follower did not resync the active detail tab');
    const eventsBeforeRecoveryTyping = engine.eventCount;
    assert.equal(
      await leaderDetailPage.evaluate(() => document.__mirrorCaptureInstalled === true),
      true,
      'leader capture disappeared during follower recovery'
    );
    const recoveryTypingStartedAt = Date.now();
    await leaderDetailPage.locator('#recovery-input').pressSequentially('recovered and mirroring', { delay: 4 });
    const leaderTypingState = await leaderDetailPage.evaluate(() => ({
      value: document.getElementById('recovery-input').value,
      trusted: window.__lastInputTrusted,
      binding: typeof window.__mirrorEmit,
    }));
    leaderTypingState.running = engine.running;
    leaderTypingState.mirroring = engine.mirroring;
    leaderTypingState.tracked = engine.leaderPages.has(leaderDetailPage);
    leaderTypingState.activeUrl = engine.activeLeaderPage && engine.activeLeaderPage.url();
    await waitFor(
      () => engine.eventCount > eventsBeforeRecoveryTyping,
      `leader recovery typing was not captured; state: ${JSON.stringify(leaderTypingState)}; logs: ${JSON.stringify(runtimeLogs.slice(-8))}`
    );
    await waitFor(
      () => recoveredDetailPage.locator('#recovery-input').inputValue()
        .then((value) => value === 'recovered and mirroring')
        .catch(() => false),
      `typing did not resume after automatic follower recovery; logs: ${JSON.stringify(runtimeLogs.slice(-8))}`
    );
    const recoveryTypingMirrorLatencyMs = Date.now() - recoveryTypingStartedAt;
    assert.ok(
      recoveryTypingMirrorLatencyMs < 750,
      `recovered typing mirror latency was too high: ${recoveryTypingMirrorLatencyMs}ms`
    );

    // Pause must leave every controlled browser and paired tab alive. Leader
    // navigation is intentionally held while paused, then the same follower
    // page catches up immediately when mirroring resumes.
    const leaderTabsBeforePause = engine.leaderCtx.pages().slice();
    const followerTabsBeforePause = recoveredFollower.context.pages().slice();
    const followerUrlBeforePause = recoveredDetailPage.url();
    const pausedStatus = await engine.setMirroring(false);
    assert.equal(pausedStatus.running, true);
    assert.equal(pausedStatus.mirroring, false);
    await leaderDetailPage.goto(`${baseUrl}/detail?paused=1`, { waitUntil: 'domcontentloaded' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(
      recoveredDetailPage.url(),
      followerUrlBeforePause,
      'follower navigation continued while mirroring was paused'
    );
    assert.equal(engine.leaderCtx.pages().length, leaderTabsBeforePause.length, 'pause changed leader tab count');
    assert.equal(
      engine.leaderCtx.pages().every((page, index) => page === leaderTabsBeforePause[index]),
      true,
      'pause replaced a leader tab'
    );
    assert.equal(recoveredFollower.context.pages().length, followerTabsBeforePause.length, 'pause changed follower tab count');
    assert.equal(
      recoveredFollower.context.pages().every((page, index) => page === followerTabsBeforePause[index]),
      true,
      'pause replaced a follower tab'
    );

    const resumedStatus = await engine.setMirroring(true);
    assert.equal(resumedStatus.running, true);
    assert.equal(resumedStatus.mirroring, true);
    await waitFor(
      () => recoveredDetailPage.url() === `${baseUrl}/detail?paused=1`,
      'resume did not synchronize the current leader URL'
    );
    assert.equal(engine.leaderCtx.pages().length, leaderTabsBeforePause.length, 'resume changed leader tab count');
    assert.equal(
      engine.leaderCtx.pages().every((page, index) => page === leaderTabsBeforePause[index]),
      true,
      'resume replaced a leader tab'
    );
    assert.equal(recoveredFollower.context.pages().length, followerTabsBeforePause.length, 'resume changed follower tab count');
    assert.equal(
      recoveredFollower.context.pages().every((page, index) => page === followerTabsBeforePause[index]),
      true,
      'resume replaced a follower tab'
    );

    // The low-latency text path must retain non-append editing semantics.
    const leaderRecoveryInput = leaderDetailPage.locator('#recovery-input');
    const followerRecoveryInput = recoveredDetailPage.locator('#recovery-input');
    const accuracyEditingStartedAt = Date.now();
    await leaderRecoveryInput.press('Control+A');
    await leaderDetailPage.keyboard.insertText('mirror accuracy');
    await waitFor(
      () => followerRecoveryInput.inputValue().then((value) => value === 'mirror accuracy'),
      'full selection replacement lost typing accuracy'
    );
    await leaderRecoveryInput.press('Home');
    await leaderDetailPage.keyboard.insertText('X');
    await waitFor(
      () => followerRecoveryInput.inputValue().then((value) => value === 'Xmirror accuracy'),
      'insertion at the beginning lost typing accuracy'
    );
    await leaderRecoveryInput.press('End');
    await leaderRecoveryInput.press('Backspace');
    await waitFor(
      () => followerRecoveryInput.inputValue().then((value) => value === 'Xmirror accurac'),
      'backspace editing lost typing accuracy'
    );
    const accuracyEditingMirrorMs = Date.now() - accuracyEditingStartedAt;
    assert.equal(
      recoveredFollower.context.pages().some((page) => isFeedbackProxyUrl(page.url())),
      false,
      'automatic recovery restored a feedback proxy as a top-level tab'
    );

    console.log(JSON.stringify({
      ok: true,
      build: loaded.build,
      iframeNavigationIgnored: true,
      mainFrameNavigationMirrored: true,
      dirtySessionRestoreBackedUp: true,
      staleFollowerProxyRecovered: true,
      popupOwnershipMirrored: true,
      previousTabActivationMirrored: true,
      followerPopupGuardedBeforeTabCreation: true,
      followerAutoRecovered: true,
      mirroringResumedAfterRecovery: true,
      pauseKeptBrowserTabsOpen: true,
      resumeCaughtUpCurrentUrl: true,
      recoveryTypingMirrorLatencyMs,
      selectionReplacementMirrored: true,
      middleAndDeletionEditingMirrored: true,
      accuracyEditingMirrorMs,
      followerUrl: recoveredDetailPage.url(),
      followerDetailUrl: recoveredDetailPage.url(),
      followerTabs: recoveredFollower.context.pages().length,
    }, null, 2));
  } finally {
    await engine.stop().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function isFeedbackProxyUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname.endsWith('clients6.google.com') && url.pathname === '/static/proxy.html';
  } catch (_) {
    return false;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
