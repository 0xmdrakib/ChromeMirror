'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');
const { createMockLicenseServer } = require('../tests/helpers/mock-license-server');

const root = path.join(__dirname, '..');
const appPath = path.join(root, 'build-app');
const electronPath = require('electron');
const sampleKey = 'CMIR-ABCD-EFGH-JKLM-NPQR';
const artifactDir = path.join(root, 'test-results', 'desktop-ui');

async function launch(userDataDir, apiUrl, graceMs) {
  return electron.launch({
    executablePath: electronPath,
    args: [appPath],
    cwd: root,
    env: {
      ...process.env,
      LICENSE_API_URL: apiUrl,
      CM_USER_DATA_DIR: userDataDir,
      CM_LICENSE_OFFLINE_GRACE_MS: String(graceMs),
    },
    timeout: 20_000,
  });
}

async function verifyPasteAndDashboard(server, userDataDir) {
  const app = await launch(
    userDataDir,
    `${server.baseUrl}/api/v1/license-success`,
    600_000
  );

  try {
    const page = await app.firstWindow();
    await page.waitForSelector('#keyInput');
    assert.equal(await page.title(), 'Activate Chrome Mirror');

    const pasted = await page.locator('#keyInput').evaluate((input, key) => {
      input.value = 'CMIR-OLD';
      input.setSelectionRange(input.value.length, input.value.length);
      const clipboard = new DataTransfer();
      clipboard.setData('text/plain', key);
      input.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      }));
      return {
        value: input.value,
        start: input.selectionStart,
        end: input.selectionEnd,
      };
    }, sampleKey);

    assert.deepEqual(pasted, {
      value: sampleKey,
      start: sampleKey.length,
      end: sampleKey.length,
    });
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#keyInput').inputValue(), sampleKey);
    await page.screenshot({ path: path.join(artifactDir, 'activation-paste.png') });

    await page.locator('#activateBtn').click();
    await page.waitForSelector('#startBtn', { timeout: 10_000 });
    assert.equal(await page.title(), 'Chrome Mirror');

    const dashboard = await page.evaluate(() => {
      const ids = ['tileNowBtn', 'pauseResumeBtn', 'stopBtn', 'startBtn'];
      const buttons = Object.fromEntries(ids.map((id) => {
        const button = document.getElementById(id);
        const icon = button.querySelector('svg');
        const buttonRect = button.getBoundingClientRect();
        const iconRect = icon.getBoundingClientRect();
        const style = getComputedStyle(button);
        return [id, {
          display: style.display,
          flexDirection: style.flexDirection,
          whiteSpace: style.whiteSpace,
          centerDeltaY: Math.abs(
            (buttonRect.top + buttonRect.height / 2)
            - (iconRect.top + iconRect.height / 2)
          ),
          iconLeftOfCenter: iconRect.right < buttonRect.left + buttonRect.width / 2,
        }];
      }));
      return {
        buttons,
        pauseLabel: document.getElementById('pauseResumeText').textContent,
        pauseDisabledBeforeSession: document.getElementById('pauseResumeBtn').disabled,
        hasVisibleVersion: document.body.innerText.includes('v2.0.0'),
      };
    });

    for (const [id, button] of Object.entries(dashboard.buttons)) {
      assert.ok(
        ['flex', 'inline-flex'].includes(button.display),
        `${id} should use flex layout`
      );
      assert.equal(button.flexDirection, 'row', `${id} should be horizontal`);
      assert.equal(button.whiteSpace, 'nowrap', `${id} should not wrap`);
      assert.ok(button.centerDeltaY <= 1, `${id} icon should be vertically centered`);
      assert.equal(button.iconLeftOfCenter, true, `${id} icon should stay before its label`);
    }
    assert.equal(dashboard.pauseLabel, 'Pause mirror');
    assert.equal(dashboard.pauseDisabledBeforeSession, true);
    assert.equal(dashboard.hasVisibleVersion, false);
    await page.screenshot({ path: path.join(artifactDir, 'dashboard-buttons.png') });

    return dashboard;
  } finally {
    await app.close();
  }
}

async function verifyRetry(server, userDataDir) {
  const app = await launch(
    userDataDir,
    `${server.baseUrl}/api/v1/license-retry-sequence`,
    0
  );

  try {
    const page = await app.firstWindow();
    await page.waitForSelector('#retryBtn');
    assert.equal(await page.title(), 'Chrome Mirror - Locked');

    let navigationCount = 0;
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigationCount += 1;
    });

    await page.locator('#retryBtn').click();
    await page.locator('#retryStatus[data-state="error"]').waitFor();
    assert.equal(navigationCount, 0, 'blocked retry must not reload the renderer');
    assert.equal(await page.locator('#retryBtn').isEnabled(), true);
    assert.match(
      await page.locator('#retryStatus').innerText(),
      /unable to reach the license server/i
    );
    await page.screenshot({ path: path.join(artifactDir, 'retry-failure.png') });

    await page.locator('#retryBtn').click();
    await page.waitForSelector('#startBtn', { timeout: 10_000 });
    assert.equal(await page.title(), 'Chrome Mirror');
    assert.equal(navigationCount, 1, 'successful retry must navigate exactly once');
  } finally {
    await app.close();
  }
}

async function verifySavedActivation(server, userDataDir) {
  const app = await launch(
    userDataDir,
    `${server.baseUrl}/api/v1/license-success`,
    600_000
  );
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('#startBtn', { timeout: 10_000 });
    assert.equal(await page.title(), 'Chrome Mirror');
    assert.equal(await page.locator('#keyInput').count(), 0, 'saved activation must not ask for the key again');
  } finally {
    await app.close();
  }
  assert.equal(server.stats().releaseCalls, 0, 'normal app close must not release the device lease');
}

async function verifyExpiredSessionResume(server) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-mirror-resume-'));
  const apiUrl = `${server.baseUrl}/api/v1/license-expired-session`;
  const activationCallsBefore = server.stats().activationCalls;
  try {
    const first = await launch(userDataDir, apiUrl, 600_000);
    try {
      const page = await first.firstWindow();
      await page.waitForSelector('#keyInput');
      await page.locator('#keyInput').fill(sampleKey);
      await page.locator('#activateBtn').click();
      await page.waitForSelector('#startBtn', { timeout: 10_000 });
    } finally {
      await first.close();
    }

    const resumed = await launch(userDataDir, apiUrl, 600_000);
    try {
      const page = await resumed.firstWindow();
      await page.waitForSelector('#startBtn', { timeout: 10_000 });
      assert.equal(await page.locator('#keyInput').count(), 0, 'expired access token asked for the key again');
    } finally {
      await resumed.close();
    }

    assert.equal(server.stats().activationCalls, activationCallsBefore + 1);
    assert.equal(server.stats().resumeCalls > 0, true, 'saved same-device session did not use silent resume');
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

async function verifyMissingResumeEndpointFallback(server) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-mirror-no-resume-'));
  const apiUrl = `${server.baseUrl}/api/v1/license-expired-no-resume`;
  try {
    const first = await launch(userDataDir, apiUrl, 600_000);
    try {
      const page = await first.firstWindow();
      await page.waitForSelector('#keyInput');
      await page.locator('#keyInput').fill(sampleKey);
      await page.locator('#activateBtn').click();
      await page.waitForSelector('#startBtn', { timeout: 10_000 });
    } finally {
      await first.close();
    }

    const reopened = await launch(userDataDir, apiUrl, 600_000);
    try {
      const page = await reopened.firstWindow();
      await page.waitForSelector('#startBtn', { timeout: 10_000 });
      assert.equal(await page.locator('#keyInput').count(), 0, 'raw 404 resume fallback asked for the key');
      assert.equal(await page.locator('#retryBtn').count(), 0, 'raw 404 resume fallback locked the app');
    } finally {
      await reopened.close();
    }
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

(async () => {
  fs.mkdirSync(artifactDir, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-mirror-ui-'));
  const server = await createMockLicenseServer();

  try {
    const dashboard = await verifyPasteAndDashboard(server, userDataDir);
    await verifySavedActivation(server, userDataDir);
    await verifyExpiredSessionResume(server);
    await verifyMissingResumeEndpointFallback(server);
    await verifyRetry(server, userDataDir);
    console.log(JSON.stringify({
      ok: true,
      pasteStable: true,
      activationSurvivesRestart: true,
      normalCloseReleaseCalls: server.stats().releaseCalls,
      expiredTokenResumedWithoutKey: true,
      missingResumeEndpointUsedCachedActivation: true,
      retryFailureStayedOnPage: true,
      retrySuccessNavigatedOnce: true,
      visibleVersionRemoved: true,
      buttonGeometry: dashboard.buttons,
      screenshots: artifactDir,
    }, null, 2));
  } finally {
    await server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
