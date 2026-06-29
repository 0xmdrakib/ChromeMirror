'use strict';

const { chromium } = require('playwright-core');
const installMirrorCapture = require('./capture-script');
const { replayEvent } = require('./replay');

const LAUNCH_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-session-crashed-bubble',
  '--hide-crash-restore-bubble',
];

const INPUT_DEBOUNCE_MS = 80;
const NAV_RELOAD_COOLDOWN_MS = 1200;

// Friendly start pages loaded into the first tab pair at session start, so the
// user immediately sees mirroring work instead of a blank tab.
function startPage(role) {
  const isLeader = role === 'leader';
  const badge = isLeader
    ? '<span class="badge lead">● LEADER · use this window</span>'
    : '<span class="badge fol">↻ FOLLOWER · mirrors the leader</span>';
  const head = isLeader ? 'Mirroring is active' : 'This window is the mirror';
  const body = isLeader
    ? 'Open any site here (a new tab works too). Everything you do <b>here</b> is copied 1:1 to the Follower window on the right.'
    : "You don't need to touch this window — it copies whatever you do in the Leader, tab for tab.";
  const hint = isLeader ? 'Try the box below, or open a new tab (Ctrl+T) and go to any site.' : '';
  return (
    'data:text/html,' +
    encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><title>Chrome Mirror</title>
<style>*{box-sizing:border-box}html,body{margin:0;height:100%}
body{display:grid;place-items:center;background:#f4f5f7;font-family:-apple-system,"Segoe UI",Roboto,sans-serif;color:#111827;padding:24px}
.card{max-width:560px;width:100%;background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:40px;box-shadow:0 1px 3px rgba(16,24,40,.12);text-align:center}
.badge{display:inline-block;font-size:12px;font-weight:600;letter-spacing:.4px;padding:6px 13px;border-radius:999px;margin-bottom:18px}
.badge.lead{background:#eef2ff;color:#3730a3}.badge.fol{background:#ecfdf5;color:#065f46}
h1{font-size:23px;margin:0 0 10px}p{color:#6b7280;font-size:15px;line-height:1.6;margin:0 0 22px}
label{display:block;text-align:left;font-size:13px;font-weight:600;margin-bottom:8px;color:#374151}
input{width:100%;font-size:16px;padding:13px 15px;border:1px solid #d1d5db;border-radius:10px;outline:none}
input:focus{border-color:#2563eb}.hint{margin-top:14px;font-size:13px;color:#9ca3af}</style></head>
<body><div class="card">${badge}<h1>${head}</h1><p>${body}</p>
<label>${isLeader ? 'Try it — type below and watch the other window:' : 'Mirrored text appears here:'}</label>
<input id="demo" placeholder="${isLeader ? 'Type something here…' : 'waiting for the leader…'}"${isLeader ? ' autofocus' : ''}>
${hint ? '<div class="hint">' + hint + '</div>' : ''}</div></body></html>`)
  );
}
const LEADER_START = startPage('leader');
const FOLLOWER_START = startPage('follower');

// Small fixed badge injected into every follower tab so the window is
// recognizable as the live mirror.
function installFollowerBadge() {
  if (window.__mirrorBadge) return;
  function add() {
    if (!document.body || document.getElementById('__cm_badge')) return;
    var b = document.createElement('div');
    b.id = '__cm_badge';
    b.textContent = '● MIRROR';
    b.style.cssText =
      'position:fixed;top:10px;right:10px;z-index:2147483647;pointer-events:none;' +
      'font:600 11px/1 system-ui,sans-serif;color:#fff;background:rgba(220,38,38,.92);' +
      'padding:6px 10px;border-radius:999px;box-shadow:0 2px 10px rgba(0,0,0,.35);letter-spacing:.5px;';
    document.body.appendChild(b);
    window.__mirrorBadge = true;
  }
  if (document.body) add();
  else document.addEventListener('DOMContentLoaded', add);
}

/**
 * True 1:1 mirroring. Each LEADER tab is paired with its own FOLLOWER tab.
 * Actions captured in a leader tab are replayed (trusted) in that tab's paired
 * follower tab; navigations are mirrored per tab; opening/closing a leader tab
 * opens/closes its follower tab. New leader tabs create their follower tab
 * immediately, including Chrome's built-in New Tab page, so the tab strip stays
 * 1:1 before the user navigates to a normal website.
 */
class MirrorEngine {
  constructor({ onStatus, onLog } = {}) {
    this.onStatus = onStatus || (() => {});
    this.onLog = onLog || (() => {});

    this.leaderCtx = null;
    this.followerCtx = null;
    this.activeLeaderPage = null;

    // leaderPage -> pair { follower, preassigned, creating, navChain, queue,
    //                      draining, inputDebounce, desiredUrl, lastNavAt,
    //                      tracked }
    this.pairs = new Map();

    this.running = false;
    this.mirroring = false;
    this.eventCount = 0;
    this._poll = null;
    this._reconciling = false;
  }

  // Back-compat helper: the follower paired with the currently active leader
  // (resolves the preassigned first-tab follower before it's bound on use).
  get followerPage() {
    const pair = this.activeLeaderPage && this.pairs.get(this.activeLeaderPage);
    if (!pair) return null;
    return pair.follower || pair.preassigned || null;
  }

  status() {
    return {
      running: this.running,
      mirroring: this.mirroring,
      eventCount: this.eventCount,
      leaderUrl: this.activeLeaderPage ? safeUrl(this.activeLeaderPage) : null,
      tabs: this.pairs.size,
    };
  }

  _emitStatus() {
    this.onStatus(this.status());
  }

  async start({ leaderProfile, followerProfile, settings, executablePath, headless = false, leaderArgs = [], followerArgs = [] }) {
    if (this.running) throw new Error('A session is already running.');
    this.settings = settings || {};
    this.eventCount = 0;
    this.pairs = new Map();
    this.activeLeaderPage = null;

    const baseOpts = { headless, viewport: null, chromiumSandbox: true };
    if (executablePath) baseOpts.executablePath = executablePath;
    else baseOpts.channel = 'chrome';

    this.leaderCtx = await chromium.launchPersistentContext(leaderProfile.dir, {
      ...baseOpts,
      args: [...LAUNCH_ARGS, ...leaderArgs],
    });
    this.followerCtx = await chromium.launchPersistentContext(followerProfile.dir, {
      ...baseOpts,
      args: [...LAUNCH_ARGS, ...followerArgs],
    });

    // Capture wiring on the leader context (covers every tab, now and future).
    await this.leaderCtx.exposeBinding('__mirrorEmit', (source, data) => this._onEvent(source.page, data, source.frame));
    await this.leaderCtx.addInitScript(installMirrorCapture);
    await this.followerCtx.addInitScript(installFollowerBadge);

    // First leader tab pairs with the follower's existing first tab.
    const firstLeader = this.leaderCtx.pages()[0] || (await this.leaderCtx.newPage());
    const firstFollower = this.followerCtx.pages()[0] || (await this.followerCtx.newPage());
    const firstPair = this._ensurePair(firstLeader);
    firstPair.preassigned = firstFollower;

    // Wire existing + future leader tabs.
    this.leaderCtx.on('page', (p) => this._onLeaderPage(p));
    for (const p of this.leaderCtx.pages()) this._trackLeaderPage(p);
    this.activeLeaderPage = firstLeader;

    // Install capture into already-open leader pages.
    for (const p of this.leaderCtx.pages()) p.evaluate(installMirrorCapture).catch(() => {});

    // End the session if the user closes a whole window.
    this.leaderCtx.on('close', () => this._onContextClosed('Leader'));
    this.followerCtx.on('close', () => this._onContextClosed('Follower'));

    // Onboarding: if the first leader tab is blank, show the start pages so the
    // user sees mirroring immediately.
    const url = safeUrl(firstLeader);
    if (!url || url === 'about:blank' || url.startsWith('chrome://') || url.startsWith('chrome-error')) {
      await firstLeader.goto(LEADER_START).catch(() => {});
      await firstFollower.goto(FOLLOWER_START).catch(() => {});
    } else if (/^https?:/.test(url)) {
      this._syncNav(firstLeader, url);
    }

    this.running = true;
    this.mirroring = true;
    // Reconcile loop keeps every leader tab paired with a live mirror tab.
    this._poll = setInterval(() => this._reconcile(), 500);
    this.onLog({ level: 'info', text: 'Session started — mirroring is ON. Use the left (Leader) window.' });
    this._emitStatus();
  }

  async stop() {
    if (!this.running && !this.leaderCtx && !this.followerCtx) return;
    this.running = false;
    this.mirroring = false;
    if (this._poll) { clearInterval(this._poll); this._poll = null; }
    for (const pair of this.pairs.values()) {
      for (const pending of pair.inputDebounce.values()) clearTimeout(pending.timer || pending);
      pair.inputDebounce.clear();
      pair.queue = [];
    }
    this.pairs = new Map();
    this.activeLeaderPage = null;

    const l = this.leaderCtx;
    const f = this.followerCtx;
    this.leaderCtx = this.followerCtx = null;
    try { if (l) await l.close(); } catch (_) {}
    try { if (f) await f.close(); } catch (_) {}

    this.onLog({ level: 'info', text: 'Session stopped' });
    this._emitStatus();
  }

  setMirroring(on) {
    if (!this.running) return;
    this.mirroring = !!on;
    this.onLog({ level: 'info', text: `Mirroring turned ${on ? 'ON' : 'OFF'}` });
    this._emitStatus();
  }

  /* --------------------------- tab pairing --------------------------- */

  _ensurePair(leaderPage) {
    let pair = this.pairs.get(leaderPage);
    if (!pair) {
      pair = {
        follower: null,
        preassigned: null,
        creating: null,
        navChain: Promise.resolve(),
        queue: [],
        draining: false,
        inputDebounce: new Map(),
        desiredUrl: null,
        lastNavAt: 0,
        tracked: false,
        suppressNavUntil: 0,
      };
      this.pairs.set(leaderPage, pair);
    }
    return pair;
  }

  _onLeaderPage(p) {
    this._trackLeaderPage(p);
    p.evaluate(installMirrorCapture).catch(() => {});
    this._openFollowerForLeaderTab(p);
  }

  _openFollowerForLeaderTab(p) {
    const pair = this._ensurePair(p);
    if (pair.follower || pair.preassigned || pair.creating || !this.followerCtx) return;
    pair.creating = (async () => {
      const fp = await this.followerCtx.newPage();
      pair.follower = fp;
      if (this.running) this.onLog({ level: 'info', text: 'opened a mirror tab for the new leader tab' });
      return fp;
    })().catch(() => {
      pair.creating = null;
      return null;
    });
  }

  _trackLeaderPage(p) {
    if (!p) return;
    const pair = this._ensurePair(p);
    this.activeLeaderPage = p;
    if (pair.tracked) return;
    pair.tracked = true;

    p.on('framenavigated', (frame) => {
      if (frame === p.mainFrame()) {
        this.activeLeaderPage = p;
        this._syncNav(p, p.url());
        this._emitStatus();
      }
    });
    p.on('close', () => {
      const closedPair = this.pairs.get(p);
      this.pairs.delete(p);
      if (closedPair && closedPair.follower) closedPair.follower.close().catch(() => {});
      if (this.activeLeaderPage === p) this.activeLeaderPage = this.leaderCtx ? this.leaderCtx.pages()[0] || null : null;
    });
  }

  // Reconcile poll: keep leader pages tracked and re-install capture if a site
  // replaces the execution context. Navigation itself is event-driven so the
  // follower is not forced into refresh loops on redirects or account-specific
  // pages.
  async _reconcile() {
    if (this._reconciling || !this.running || !this.leaderCtx) return;
    this._reconciling = true;
    try {
      let pages;
      try {
        pages = this.leaderCtx.pages();
      } catch (_) {
        return;
      }
      for (const lp of pages) {
        this._trackLeaderPage(lp);
        const u = safeUrl(lp);
        if (u && /^https?:/.test(u)) {
          try {
            const ok = await lp.evaluate(() => !!window.__mirrorCaptureInstalled);
            if (!ok) await lp.evaluate(installMirrorCapture).catch(() => {});
          } catch (_) {}
        }
      }
    } finally {
      this._reconciling = false;
    }
  }

  // Resolve (creating if needed) the follower page for a leader tab.
  async _follower(leaderPage) {
    const pair = this._ensurePair(leaderPage);
    if (pair.follower && !pair.follower.isClosed()) return pair.follower;
    if (!pair.creating) {
      pair.creating = (async () => {
        let fp = pair.preassigned;
        pair.preassigned = null;
        if (!fp || fp.isClosed()) {
          if (!this.followerCtx) return null;
          fp = await this.followerCtx.newPage();
          if (this.running) this.onLog({ level: 'info', text: 'opened a mirror tab for the new leader tab' });
        }
        pair.follower = fp;
        return fp;
      })().catch(() => null);
    }
    return pair.creating;
  }

  /* --------------------------- events --------------------------- */

  _onEvent(leaderPage, dataStr, leaderFrame) {
    if (!this.running || !this.mirroring) return;
    let ev;
    try {
      ev = JSON.parse(dataStr);
    } catch (_) {
      return;
    }
    if (leaderPage) this.activeLeaderPage = leaderPage;
    ev.__url = leaderPage ? safeUrl(leaderPage) : null;
    ev.__frameUrl = leaderFrame ? safeFrameUrl(leaderFrame) : null;
    if (isSensitiveChallengeUrl(ev.__url) || isSensitiveChallengeUrl(ev.__frameUrl)) {
      this.onLog({ level: 'warn', text: 'security challenge action not mirrored; solve it separately in each profile' });
      return;
    }

    if (ev.kind === 'nav') {
      if (leaderPage && ev.href && /^https?:/.test(ev.href)) {
        this._syncNav(leaderPage, ev.href);
      }
      return;
    }

    this.eventCount++;
    this._logEvent(ev);

    const pair = this._ensurePair(leaderPage);
    if (ev.kind === 'click' && ev.isSubmit) {
      pair.suppressNavUntil = Date.now() + 3500;
    }

    if (ev.kind === 'input' || ev.kind === 'text-op') {
      const key = (ev.selectors && ev.selectors[0]) || 'contenteditable';
      const prev = pair.inputDebounce.get(key);
      if (prev) {
        clearTimeout(prev.timer);
        if (ev.kind === 'text-op' && prev.ev && prev.ev.kind === 'text-op') {
          ev.valueBefore = prev.ev.valueBefore;
          ev.selectionBefore = prev.ev.selectionBefore;
        }
      }
      const timer = setTimeout(() => {
        pair.inputDebounce.delete(key);
        pair.queue.push(ev);
        this._drain(leaderPage);
      }, INPUT_DEBOUNCE_MS);
      pair.inputDebounce.set(key, { timer, ev });
      this._emitStatus();
      return;
    }

    this._flushPendingInputs(pair, leaderPage);
    pair.queue.push(ev);
    this._drain(leaderPage);
    this._emitStatus();
  }

  _flushPendingInputs(pair, leaderPage) {
    for (const [key, pending] of pair.inputDebounce.entries()) {
      clearTimeout(pending.timer || pending);
      pair.inputDebounce.delete(key);
      if (pending.ev) pair.queue.push(pending.ev);
    }
    if (pair.queue.length) this._drain(leaderPage);
  }

  async _drain(leaderPage) {
    const pair = this.pairs.get(leaderPage);
    if (!pair || pair.draining) return;
    pair.draining = true;
    try {
      while (pair.queue.length) {
        const ev = pair.queue.shift();
        const fp = await this._follower(leaderPage);
        if (!fp) break;
        try {
          if (ev.__url) {
            await this._ensureFollowerUrl(leaderPage, ev.__url);
            if (this._isStaleEvent(pair, ev, fp)) continue;
          }
          const target = await this._replayTarget(fp, ev);
          await replayEvent(target, ev, this.settings);
        } catch (e) {
          if (!this._isStaleEvent(pair, ev, fp)) {
            this.onLog({ level: 'error', text: `replay ${ev.kind}: ${shortErr(e)}` });
          }
        }
      }
    } finally {
      pair.draining = false;
    }
  }

  /* --------------------------- navigation --------------------------- */

  _isStaleEvent(pair, ev, followerPage) {
    if (!ev || !ev.__url || ev.kind === 'scroll') return false;
    if (!/^https?:/.test(ev.__url)) return false;
    if (pair && pair.desiredUrl && !sameUrl(pair.desiredUrl, ev.__url)) return true;
    return followerPage && !sameUrl(safeUrl(followerPage), ev.__url);
  }

  async _replayTarget(followerPage, ev) {
    if (!ev || !ev.__frameUrl || !followerPage || !/^https?:/.test(ev.__frameUrl)) return followerPage;
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      for (const frame of followerPage.frames()) {
        if (sameUrl(safeFrameUrl(frame), ev.__frameUrl)) return frame;
      }
      await sleep(75);
    }
    return followerPage;
  }

  _syncNav(leaderPage, url) {
    if (!this.running || !this.mirroring) return;
    if (!url || !/^https?:/.test(url)) return; // skip blank/start/chrome pages
    const pair = this.pairs.get(leaderPage);
    if (pair && pair.suppressNavUntil && Date.now() < pair.suppressNavUntil) return;
    this._ensureFollowerUrl(leaderPage, url);
  }

  // Keep a leader tab's paired follower on the same URL (serialized per pair).
  _ensureFollowerUrl(leaderPage, url) {
    if (!url || !/^https?:/.test(url)) return Promise.resolve();
    const pair = this._ensurePair(leaderPage);
    if (sameUrl(pair.desiredUrl, url) && Date.now() - pair.lastNavAt < NAV_RELOAD_COOLDOWN_MS) {
      return pair.navChain;
    }
    pair.desiredUrl = url;
    pair.navChain = pair.navChain.then(async () => {
      const fp = await this._follower(leaderPage);
      if (!fp || fp.isClosed()) return;
      if (!sameUrl(pair.desiredUrl, url)) return;
      if (sameUrl(safeUrl(fp), url)) return;
      try {
        pair.lastNavAt = Date.now();
        await fp.goto(url, { timeout: 9000, waitUntil: 'commit' });
        await fp.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => {});
        this.onLog({ level: 'info', text: `follower → ${shortUrl(url)}` });
      } catch (_) {
        /* navigation aborted — replay will simply not find elements */
      }
    });
    return pair.navChain;
  }

  _onContextClosed(which) {
    if (!this.running) return;
    this.onLog({ level: 'warn', text: `${which} browser was closed — ending session` });
    this.stop();
  }

  _logEvent(ev) {
    this.onLog({ level: 'event', text: describeEvent(ev) });
  }
}

function describeEvent(ev) {
  const sel = (ev.selectors && ev.selectors[0]) || ev.tag || '';
  switch (ev.kind) {
    case 'click':
      return `click  ${sel}${ev.text ? '  “' + ev.text.trim().slice(0, 24) + '”' : ''}`;
    case 'input':
      return `type   ${sel} = ${ev.isPassword ? '••••••' : '“' + (ev.value || '').slice(0, 28) + '”'}`;
    case 'text-op':
      return `text   ${ev.inputType || 'edit'} ${sel}${ev.data ? ' = ' + JSON.stringify(ev.data.slice(0, 24)) : ''}`;
    case 'select':
      return `select ${sel} = ${ev.value}`;
    case 'check':
      return `${ev.checked ? 'check  ' : 'uncheck'} ${sel}`;
    case 'key': {
      const combo = [ev.ctrl && 'Ctrl', ev.alt && 'Alt', ev.shift && 'Shift', ev.meta && 'Meta', ev.key]
        .filter(Boolean)
        .join('+');
      return `key    ${combo}`;
    }
    case 'scroll':
      return `scroll ${ev.y}px`;
    default:
      return ev.kind;
  }
}

function safeUrl(page) {
  try {
    return page.url();
  } catch (_) {
    return null;
  }
}
function safeFrameUrl(frame) {
  try {
    return frame.url();
  } catch (_) {
    return null;
  }
}
function shortUrl(u) {
  try {
    const x = new URL(u);
    return (x.host + x.pathname).slice(0, 48);
  } catch (_) {
    return String(u).slice(0, 48);
  }
}
function sameUrl(a, b) {
  if (!a || !b) return false;
  try {
    const A = new URL(a);
    const B = new URL(b);
    return A.host === B.host && A.pathname === B.pathname && A.search === B.search;
  } catch (_) {
    return a === b;
  }
}
function shortErr(e) {
  return String((e && e.message) || e).split('\n')[0].slice(0, 120);
}
function isSensitiveChallengeUrl(url) {
  if (!url) return false;
  const u = String(url).toLowerCase();
  return (
    u.includes('challenges.cloudflare.com') ||
    u.includes('/cdn-cgi/challenge-platform/') ||
    u.includes('captcha') ||
    u.includes('turnstile')
  );
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { MirrorEngine };
