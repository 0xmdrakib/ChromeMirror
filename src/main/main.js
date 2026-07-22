'use strict';

const { app, BrowserWindow, ipcMain, screen, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { ProfileStore } = require('./profiles');
const { MirrorEngine } = require('./mirror-engine');
const { LicenseClient, STATE } = require('./license-client');
const { stopLicenseForShutdown } = require('./license-lifecycle');
const { licensePageForState, shouldNavigateAfterRetry } = require('./license-routing');
const { createWindowPlan } = require('./window-layout');
const { DiagnosticsLog } = require('./diagnostics');

let win = null;
let store = null;
let engine = null;
let license = null;
let licenseNavigationTimer = null;
let diagnostics = null;

// Keep manual development and UI verification isolated from installed data.
if (!app.isPackaged && process.env.CM_USER_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.CM_USER_DATA_DIR));
}

// ---------------------------------------------------------------------------
// Anti-debug / hardening (production only). Applied as early as possible.
// ---------------------------------------------------------------------------
function applyHardening() {
  if (!app.isPackaged) return; // don't slow down dev

  // Strip debug/automation switches so attackers can't attach DevTools or CDP.
  const strip = [
    '--remote-debugging-port', '--remote-debugging-pipe', '--inspect',
    '--inspect-brk', '--enable-logging', '--enable-features=Inspect',
  ];
  for (const s of strip) app.commandLine.removeSwitch(s);
}
applyHardening();

function findChrome() {
  const candidates = [
    process.env['PROGRAMFILES'] && path.join(process.env['PROGRAMFILES'], 'Google/Chrome/Application/chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
    process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA'], 'Google/Chrome/Application/chrome.exe'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) {}
  }
  return null; // fall back to Playwright's channel:'chrome'
}

function createWindow(initialPage = 'index.html') {
  win = new BrowserWindow({
    width: 1060,
    height: 740,
    minWidth: 920,
    minHeight: 620,
    title: 'Chrome Mirror',
    backgroundColor: '#0e1116',
    show: false,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox: true is implied by contextIsolation in modern Electron.
    },
  });
  win.removeMenu();

  // Block DevTools in production builds.
  if (app.isPackaged) {
    win.webContents.on('devtools-opened', () => win.webContents.closeDevTools());
  }

  win.loadFile(path.join(__dirname, '..', 'renderer', initialPage));
  win.once('ready-to-show', () => win.show());

  // Forward renderer console + crashes to the terminal (helps debugging).
  win.webContents.on('console-message', (...args) => {
    const msg = args[2] !== undefined ? args[2] : args[0] && args[0].message;
    if (msg) console.log('[renderer]', msg);
  });
  win.webContents.on('render-process-gone', (_e, d) => console.log('[render-gone]', JSON.stringify(d)));

  // One-shot layout diagnostic: run `CM_DIAG=1 npm start`.
  if (!app.isPackaged && process.env.CM_DIAG) {
    win.webContents.once('did-finish-load', async () => {
      const js = `(function(){
        var ids=['viewTitle','viewSubtitle','selectedCount','leaderSel','followerPicker','startBtn','stopBtn','leaderAvatar','mirrorLabel','layoutSelect','profileList','log','settingsForm'];
        var out={};
        ids.forEach(function(id){
          var el=document.getElementById(id);
          if(!el){out[id]='MISSING';return;}
          var cs=getComputedStyle(el); var r=el.getBoundingClientRect();
          out[id]={display:cs.display,vis:cs.visibility,h:Math.round(r.height),w:Math.round(r.width)};
        });
        out.__err=window.__lastError||null;
        out.__contentHTML=(document.querySelector('.content')||{}).innerHTML ? document.querySelector('.content').innerHTML.length : 'no-content';
        return JSON.stringify(out);
      })()`;
      try {
        const r = await win.webContents.executeJavaScript(js);
        console.log('DIAG', r);
      } catch (e) {
        console.log('DIAG-ERR', e.message);
      }
      setTimeout(() => app.quit(), 400);
    });
  }
}

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

/* ----------------------------- License gate ------------------------------ */

/**
 * Decides which screen the window shows at boot, based on the license state.
 *   active            → load the control panel + start heartbeat
 *   needs_activation  → load activate.html
 *   blocked           → load blocked.html
 *
 * Also wires the live "revoked → block" transition so that if the admin
 * suspends/cancels mid-session, the window swaps to the blocked screen.
 */
async function runLicenseGate() {
  const result = await license.checkAtBoot();
  createWindow(licensePageForState(result.state));

  if (result.state === STATE.ACTIVE) {
    license.startHeartbeat();
  }

  // Live revocation during a heartbeat.
  license.on('blocked', (reason) => {
    if (engine) { try { engine.stop(); } catch (_) {} }
    license.stopHeartbeat();
    if (win && !win.isDestroyed()) {
      win.loadFile(path.join(__dirname, '..', 'renderer', licensePageForState(STATE.BLOCKED)))
        .then(() => send('license:blocked', { reason }))
        .catch((error) => {
          console.error('[license] could not open the locked screen:', error.message);
        });
    }
  });
}

async function applyLicenseState(result) {
  if (!win || win.isDestroyed()) return;
  const page = licensePageForState(result.state);

  if (result.state !== STATE.ACTIVE) {
    license.stopHeartbeat();
  }

  await win.loadFile(path.join(__dirname, '..', 'renderer', page));

  if (result.state === STATE.ACTIVE) {
    license.startHeartbeat();
  }
}

function scheduleLicenseState(result, delayMs = 300) {
  if (licenseNavigationTimer) clearTimeout(licenseNavigationTimer);
  licenseNavigationTimer = setTimeout(() => {
    licenseNavigationTimer = null;
    applyLicenseState(result).catch((error) => {
      console.error('[license] could not change the license screen:', error.message);
    });
  }, delayMs);
}

app.whenReady().then(async () => {
  diagnostics = new DiagnosticsLog(app.getPath('userData'));
  diagnostics.write('info', 'Chrome Mirror started', { appVersion: app.getVersion(), packaged: app.isPackaged });
  store = new ProfileStore(app.getPath('userData'));
  engine = new MirrorEngine({
    onStatus: (s) => {
      diagnostics.status(s);
      send('status', s);
    },
    onLog: (l) => {
      diagnostics.write(l.level, l.text);
      send('log', Object.assign({ t: Date.now() }, l));
    },
  });
  license = new LicenseClient();

  // Set a strict CSP on the renderer session in production.
  if (app.isPackaged) {
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'",
          ],
        },
      });
    });
  }

  await runLicenseGate();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) runLicenseGate();
  });
});

app.on('window-all-closed', async () => {
  if (licenseNavigationTimer) clearTimeout(licenseNavigationTimer);
  licenseNavigationTimer = null;
  try {
    if (engine) await engine.stop();
    // A normal app/Windows shutdown must keep this computer activated.
    // Device release is an explicit portal/admin action, not an exit action.
    stopLicenseForShutdown(license);
  } catch (_) {}
  if (diagnostics) diagnostics.flushSync();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (diagnostics) diagnostics.flushSync();
});

/* ---------------------------------- IPC ---------------------------------- */

ipcMain.handle('profiles:list', () => store.list());
ipcMain.handle('profiles:create', (_e, name) => store.create(name));
ipcMain.handle('profiles:rename', (_e, id, name) => store.rename(id, name));
ipcMain.handle('profiles:delete', (_e, id) => store.remove(id));

ipcMain.handle('roles:get', () => store.getRoles());
ipcMain.handle('roles:set', (_e, leaderId, followerIds, windowLayout) =>
  store.setRoles(leaderId, followerIds, windowLayout)
);

ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:set', (_e, patch) => store.setSettings(patch));

ipcMain.handle('session:status', () => engine.status());

ipcMain.handle('session:start', async () => {
  const { leaderId, followerIds, windowLayout } = store.getRoles();
  if (!leaderId || !Array.isArray(followerIds) || !followerIds.length) {
    throw new Error('Pick one Leader and at least one Follower profile.');
  }
  if (followerIds.includes(leaderId)) throw new Error('Leader and Follower profiles must be different.');
  const leaderProfile = store.get(leaderId);
  const followerProfiles = followerIds.map((id) => store.get(id)).filter(Boolean);
  if (!leaderProfile || followerProfiles.length !== followerIds.length) {
    throw new Error('One or more selected profiles no longer exist.');
  }

  store.touch(leaderId);
  followerIds.forEach((id) => store.touch(id));

  const displays = screen.getAllDisplays();
  const plan = createWindowPlan(displays, [leaderId, ...followerIds], windowLayout);
  const leaderArgs = (plan.get(leaderId) || {}).args || [];
  const followerArgs = new Map(
    followerIds.map((id) => [id, (plan.get(id) || {}).args || []])
  );

  await engine.start({
    leaderProfile,
    followerProfiles,
    settings: store.getSettings(),
    executablePath: findChrome(),
    leaderArgs,
    followerArgs,
    displays,
  });
  return engine.status();
});

ipcMain.handle('session:stop', async () => {
  await engine.stop();
  return engine.status();
});

ipcMain.handle('mirror:set', (_e, on) => engine.setMirroring(on));

ipcMain.handle('session:focus-profile', (_e, profileId) => engine.focusProfile(profileId));
ipcMain.handle('session:retry-follower', (_e, profileId) => engine.retryFollower(profileId));
ipcMain.handle('session:layout', (_e, layout) => {
  const settings = store.setSettings({ windowLayout: layout });
  return engine.setWindowLayout(settings.windowLayout, screen.getAllDisplays());
});

/* --------------------------- License IPC --------------------------------- */

// Boot probe: renderer asks "what state are we in?" to pick its screen.
ipcMain.handle('license:check', () => {
  return {
    state: license.getState(),
    license: license.getLicense(),
    reason: license.getReason(),
  };
});

// Re-check state online (e.g. from Retry button on blocked screen)
ipcMain.handle('license:retry', async () => {
  const result = await license.checkAtBoot();
  // Keep a repeatedly blocked renderer alive so it can receive this result
  // and show useful feedback. Successful states navigate after the reply.
  if (shouldNavigateAfterRetry(result.state)) {
    scheduleLicenseState(result);
  }
  return result;
});

// Activate with a key the user typed in activate.html.
ipcMain.handle('license:activate', async (_e, key) => {
  const r = await license.activate(key);
  if (r.ok) {
    // Let the renderer receive the successful IPC response before replacing
    // the page that made the request.
    scheduleLicenseState({ state: STATE.ACTIVE }, 450);
  }
  return r;
});

// Current license info (label/status) — for an "About / License" display.
ipcMain.handle('license:status', () => {
  return {
    state: license.getState(),
    license: license.getLicense(),
    reason: license.getReason(),
  };
});
