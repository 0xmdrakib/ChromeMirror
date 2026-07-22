'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-core');
const installMirrorCapture = require('../src/main/capture-script');
const { replayEvent } = require('../src/main/replay');

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

async function withChrome(run) {
  const executablePath = findChrome();
  assert.ok(executablePath, 'Google Chrome is required for capture/replay safety tests');
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-mirror-replay-safety-'));
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless: true,
    args: ['--no-first-run'],
  });
  try {
    await run(context);
  } finally {
    await context.close().catch(() => {});
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

test('capture ignores programmatic clicks but keeps trusted user clicks', async () => {
  await withChrome(async (context) => {
    const clicks = [];
    await context.exposeBinding('__mirrorEmit', (source, raw) => {
      const event = JSON.parse(raw);
      if (event.kind === 'click') clicks.push({ event, frame: source.frame });
    });
    await context.addInitScript(installMirrorCapture);

    const page = context.pages()[0];
    const html = `
      <button id="programmatic">programmatic</button>
      <button id="user">user</button>
      <script>setTimeout(function () { programmatic.click(); }, 0);</script>
    `;
    await page.goto(`data:text/html,${encodeURIComponent(html)}`);
    await page.waitForTimeout(100);
    assert.equal(clicks.length, 0, 'an untrusted programmatic click escaped capture');

    await page.locator('#user').click();
    await page.waitForTimeout(50);
    assert.equal(clicks.length, 1);
    assert.equal(clicks[0].event.text, 'user');
  });
});

test('capture blocks Google static proxy helper-frame actions', async () => {
  await withChrome(async (context) => {
    const clicks = [];
    await context.exposeBinding('__mirrorEmit', (source, raw) => {
      const event = JSON.parse(raw);
      if (event.kind === 'click') clicks.push({ event, url: source.frame.url() });
    });
    await context.addInitScript(installMirrorCapture);
    await context.route('https://feedback-pa.clients6.google.com/static/proxy.html**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<button id="helper">helper</button>',
      })
    );

    const page = context.pages()[0];
    await page.setContent(
      '<iframe src="https://feedback-pa.clients6.google.com/static/proxy.html?usegapi=1"></iframe>'
    );
    const helper = page.frames().find((frame) =>
      frame.url().includes('feedback-pa.clients6.google.com/static/proxy.html')
    );
    assert.ok(helper, 'proxy helper frame did not load');

    await helper.locator('#helper').click();
    await page.waitForTimeout(50);
    assert.deepEqual(clicks, [], 'a trusted proxy-helper click escaped capture');
  });
});

test('hidden child-frame coordinate fallback cannot click the top-level page', async () => {
  await withChrome(async (context) => {
    const page = context.pages()[0];
    await page.setContent(`
      <button id="trap" style="position:fixed;inset:0;width:100vw;height:100vh">top-level trap</button>
      <iframe id="helper" style="display:none" srcdoc="<button id=inside>inside</button>"></iframe>
      <script>
        window.trapClicks = 0;
        trap.addEventListener('click', function () { window.trapClicks += 1; });
      </script>
    `);
    const helper = page.frames().find((frame) => frame !== page.mainFrame());
    assert.ok(helper, 'hidden helper frame did not attach');
    assert.equal(await (await helper.frameElement()).boundingBox(), null);

    const result = await replayEvent(
      helper,
      {
        kind: 'click',
        selectors: ['#missing-in-follower'],
        frac: { x: 0, y: 0 },
      },
      { coordFallback: true }
    );

    assert.deepEqual(result, { ok: false, reason: 'frame-coordinate-unavailable' });
    assert.equal(await page.evaluate(() => window.trapClicks), 0);
  });
});

test('visible child-frame coordinate fallback maps through iframe box dimensions', async () => {
  const clicks = [];
  const ownerPage = {
    mouse: {
      click: async (x, y) => clicks.push({ x, y }),
    },
  };
  const frame = {
    frameElement: async () => ({
      boundingBox: async () => ({ x: 100, y: 200, width: 400, height: 120 }),
    }),
    page: () => ownerPage,
    locator: () => ({
      count: async () => 0,
    }),
  };

  const result = await replayEvent(
    frame,
    { kind: 'click', selectors: ['#missing'], frac: { x: 0.25, y: 0.75 } },
    { coordFallback: true }
  );

  assert.deepEqual(result, { ok: true, how: 'coords' });
  assert.deepEqual(clicks, [{ x: 200, y: 290 }]);
});

test('zero-sized child-frame coordinate fallback is rejected', async () => {
  const clicks = [];
  const frame = {
    frameElement: async () => ({
      boundingBox: async () => ({ x: 100, y: 200, width: 0, height: 120 }),
    }),
    page: () => ({
      mouse: {
        click: async (x, y) => clicks.push({ x, y }),
      },
    }),
    locator: () => ({
      count: async () => 0,
    }),
  };

  const result = await replayEvent(
    frame,
    { kind: 'click', selectors: ['#missing'], frac: { x: 0.5, y: 0.5 } },
    { coordFallback: true }
  );

  assert.deepEqual(result, { ok: false, reason: 'frame-coordinate-unavailable' });
  assert.deepEqual(clicks, []);
});
