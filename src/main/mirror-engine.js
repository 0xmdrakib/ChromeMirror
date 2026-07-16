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
const MAX_QUEUE = 300;
const FOLLOWER_LAUNCH_BATCH = 3;

function startPage(role, name) {
  const isLeader = role === 'leader';
  const safeName = escapeHtml(name || (isLeader ? 'Leader' : 'Follower'));
  const badge = isLeader
    ? '<span class="badge lead">● LEADER · use this window</span>'
    : '<span class="badge fol">↻ FOLLOWER · mirrors the leader</span>';
  const head = isLeader ? 'Mirroring is active' : 'This window is the mirror';
  const body = isLeader
    ? `Open any site here. Everything you do <b>here</b> is copied to the selected follower windows.`
    : `You do not need to touch this window. It copies whatever you do in the Leader.`;
  const hint = isLeader
    ? 'Open a new tab or navigate to any site to begin.'
    : `Profile: ${safeName}`;
  return (
    'data:text/html,' +
    encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><title>Chrome Mirror</title>
<style>*{box-sizing:border-box}html,body{margin:0;height:100%}
body{display:grid;place-items:center;background:#f4f7fb;font-family:-apple-system,"Segoe UI",Roboto,sans-serif;color:#142033;padding:24px}
.card{max-width:560px;width:100%;background:#fff;border:1px solid #dce4ef;border-radius:16px;padding:40px;box-shadow:0 12px 30px rgba(18,45,78,.12);text-align:center}
.badge{display:inline-block;font-size:12px;font-weight:700;letter-spacing:.4px;padding:6px 13px;border-radius:999px;margin-bottom:18px}
.badge.lead{background:#e8f0ff;color:#1554b5}.badge.fol{background:#e6f8f4;color:#087f69}
h1{font-size:23px;margin:0 0 10px}p{color:#637087;font-size:15px;line-height:1.6;margin:0 0 22px}
.hint{margin-top:14px;font-size:13px;color:#8a96a8}</style></head>
<body><div class="card">${badge}<h1>${head}</h1><p>${body}</p><div class="hint">${hint}</div></div></body></html>`)
  );
}

function installFollowerBadge() {
  if (window.__mirrorBadge) return;
  function add() {
    if (!document.body || document.getElementById('__cm_badge')) return;
    var b = document.createElement('div');
    b.id = '__cm_badge';
    b.textContent = '● MIRROR';
    b.style.cssText =
      'position:fixed;top:10px;right:10px;z-index:2147483647;pointer-events:none;' +
      'font:700 11px/1 system-ui,sans-serif;color:#fff;background:rgba(14,116,144,.94);' +
      'padding:6px 10px;border-radius:999px;box-shadow:0 2px 10px rgba(0,0,0,.35);letter-spacing:.5px;';
    document.body.appendChild(b);
    window.__mirrorBadge = true;
  }
  if (document.body) add();
  else document.addEventListener('DOMContentLoaded', add);
}

/**
 * One leader context fans out to a bounded set of follower contexts.
 * Each follower keeps its own serial queue so a slow or closed follower
 * cannot hold up healthy followers.
 */
class MirrorEngine {
  constructor({ onStatus, onLog } = {}) {
    this.onStatus = onStatus || (() => {});
    this.onLog = onLog || (() => {});

    this.leaderCtx = null;
    this.followers = new Map();
    this.leaderPages = new Map();
    this.activeLeaderPage = null;

    this.running = false;
    this.mirroring = false;
    this.eventCount = 0;
    this.launchProgress = { completed: 0, total: 0 };
    this._poll = null;
    this._reconciling = false;
    this._startOptions = null;
  }

  get followerPage() {
    const leaderState = this.activeLeaderPage && this.leaderPages.get(this.activeLeaderPage);
    if (!leaderState) return null;
    for (const follower of this.followers.values()) {
      const pair = leaderState.followers.get(follower.id);
      if (pair && (pair.page || pair.preassigned)) return pair.page || pair.preassigned;
    }
    return null;
  }

  status() {
    const leaderUrl = this.activeLeaderPage ? safeUrl(this.activeLeaderPage) : null;
    return {
      running: this.running,
      mirroring: this.mirroring,
      eventCount: this.eventCount,
      leaderUrl,
      tabs: this.leaderPages.size,
      launchProgress: { ...this.launchProgress },
      followers: Array.from(this.followers.values()).map((f) => ({
        id: f.id,
        name: f.name,
        state: f.state,
        tabs: f.context ? f.context.pages().length : 0,
        queueDepth: f.queueDepth,
        lastError: f.lastError,
      })),
    };
  }

  _emitStatus() {
    this.onStatus(this.status());
  }

  async start({
    leaderProfile,
    followerProfiles,
    settings,
    executablePath,
    headless = false,
    leaderArgs = [],
    followerArgs = new Map(),
    displays = [],
  }) {
    if (this.running) throw new Error('A session is already running.');
    if (!leaderProfile) throw new Error('A Leader profile is required.');
    if (!Array.isArray(followerProfiles) || !followerProfiles.length) {
      throw new Error('Select at least one Follower profile.');
    }

    this.settings = settings || {};
    this.eventCount = 0;
    this.leaderPages = new Map();
    this.followers = new Map();
    this.activeLeaderPage = null;
    this.launchProgress = { completed: 0, total: followerProfiles.length + 1 };
    this._startOptions = {
      leaderProfile,
      followerProfiles,
      settings: this.settings,
      executablePath,
      headless,
      leaderArgs,
      followerArgs,
      displays,
    };

    const baseOpts = { headless, viewport: null, chromiumSandbox: true };
    if (executablePath) baseOpts.executablePath = executablePath;
    else baseOpts.channel = 'chrome';

    this.leaderCtx = await chromium.launchPersistentContext(leaderProfile.dir, {
      ...baseOpts,
      args: [...LAUNCH_ARGS, ...leaderArgs],
    });
    this.launchProgress.completed = 1;

    await this.leaderCtx.exposeBinding('__mirrorEmit', (source, data) =>
      this._onEvent(source.page, data, source.frame)
    );
    await this.leaderCtx.addInitScript(installMirrorCapture);

    const firstLeader = this.leaderCtx.pages()[0] || (await this.leaderCtx.newPage());
    this.activeLeaderPage = firstLeader;
    this.leaderCtx.on('page', (page) => this._onLeaderPage(page));
    this.leaderCtx.on('close', () => this._onContextClosed('Leader'));
    this._trackLeaderPage(firstLeader);
    for (const page of this.leaderCtx.pages()) {
      this._trackLeaderPage(page);
      page.evaluate(installMirrorCapture).catch(() => {});
    }

    for (const profile of followerProfiles) {
      this.followers.set(profile.id, {
        id: profile.id,
        name: profile.name,
        profile,
        context: null,
        state: 'launching',
        queueDepth: 0,
        lastError: null,
      });
    }
    this.running = true;
    this.mirroring = true;
    this._emitStatus();

    for (let i = 0; i < followerProfiles.length; i += FOLLOWER_LAUNCH_BATCH) {
      const batch = followerProfiles.slice(i, i + FOLLOWER_LAUNCH_BATCH);
      await Promise.all(batch.map((profile) => this._launchFollower(profile, baseOpts, followerArgs.get(profile.id) || [])));
      this._emitStatus();
    }

    const ready = Array.from(this.followers.values()).filter((f) => f.state === 'ready');
    if (!ready.length) {
      await this.stop();
      throw new Error('No follower browser could be launched.');
    }

    await this._initializeStartPages(firstLeader);
    this._poll = setInterval(() => this._reconcile(), 500);
    this.onLog({
      level: 'info',
      text: `Session started — mirroring is ON across ${ready.length} follower${ready.length === 1 ? '' : 's'}.`,
    });
    this._emitStatus();
  }

  async _launchFollower(profile, baseOpts, args) {
    const follower = this.followers.get(profile.id);
    if (!follower) return;
    try {
      const context = await chromium.launchPersistentContext(profile.dir, {
        ...baseOpts,
        args: [...LAUNCH_ARGS, ...args],
      });
      follower.context = context;
      follower.state = 'ready';
      follower.lastError = null;
      await context.addInitScript(installFollowerBadge);
      context.on('close', () => this._onFollowerContextClosed(profile.id));
      const firstPage = context.pages()[0] || (await context.newPage());
      for (const leaderPage of this.leaderPages.keys()) {
        const leaderState = this.leaderPages.get(leaderPage);
        const pair = this._ensurePair(leaderState, profile.id);
        if (leaderPage === this.activeLeaderPage && !pair.page && !pair.preassigned) {
          pair.preassigned = firstPage;
        }
      }
      this.launchProgress.completed++;
      this.onLog({ level: 'info', text: `${profile.name} is ready.` });
    } catch (error) {
      follower.state = 'error';
      follower.lastError = shortErr(error);
      this.launchProgress.completed++;
      this.onLog({ level: 'error', text: `${profile.name} failed to launch: ${follower.lastError}` });
    }
  }

  async retryFollower(profileId) {
    if (!this.running || !this._startOptions) return this.status();
    const old = this.followers.get(profileId);
    if (!old) return this.status();
    try { if (old.context) await old.context.close(); } catch (_) {}
    old.context = null;
    old.state = 'launching';
    old.lastError = null;
    this.launchProgress.total++;
    this._emitStatus();

    const baseOpts = {
      headless: this._startOptions.headless,
      viewport: null,
      chromiumSandbox: true,
    };
    if (this._startOptions.executablePath) baseOpts.executablePath = this._startOptions.executablePath;
    else baseOpts.channel = 'chrome';
    await this._launchFollower(
      old.profile,
      baseOpts,
      this._startOptions.followerArgs.get(profileId) || []
    );
    this._emitStatus();
    return this.status();
  }

  async _initializeStartPages(firstLeader) {
    const url = safeUrl(firstLeader);
    const leaderState = this.leaderPages.get(firstLeader);
    if (!leaderState) return;
    if (!url || url === 'about:blank' || url.startsWith('chrome://') || url.startsWith('chrome-error')) {
      await firstLeader.goto(startPage('leader', 'Leader')).catch(() => {});
      await Promise.all(Array.from(this.followers.values()).map(async (follower) => {
        if (follower.state !== 'ready') return;
        const pair = await this._followerPair(firstLeader, follower.id);
        if (pair && pair.page) await pair.page.goto(startPage('follower', follower.name)).catch(() => {});
      }));
    } else if (/^https?:/.test(url)) {
      await this._syncNav(firstLeader, url);
    }
  }

  async stop() {
    if (!this.running && !this.leaderCtx && !this.followers.size) return;
    this.running = false;
    this.mirroring = false;
    if (this._poll) clearInterval(this._poll);
    this._poll = null;

    for (const leaderState of this.leaderPages.values()) {
      for (const pending of leaderState.inputDebounce.values()) clearTimeout(pending.timer);
      leaderState.inputDebounce.clear();
      for (const pair of leaderState.followers.values()) {
        pair.queue = [];
        pair.queueDepth = 0;
      }
    }

    const leader = this.leaderCtx;
    const followers = Array.from(this.followers.values()).map((f) => f.context).filter(Boolean);
    this.leaderCtx = null;
    this.followers.clear();
    this.leaderPages.clear();
    this.activeLeaderPage = null;
    try { if (leader) await leader.close(); } catch (_) {}
    await Promise.all(followers.map(async (context) => {
      try { await context.close(); } catch (_) {}
    }));

    this.onLog({ level: 'info', text: 'Session stopped.' });
    this._emitStatus();
  }

  setMirroring(on) {
    if (!this.running) return;
    this.mirroring = !!on;
    this.onLog({ level: 'info', text: `Mirroring turned ${on ? 'ON' : 'OFF'}.` });
    this._emitStatus();
  }

  async focusProfile(profileId) {
    const target = profileId === 'leader' ? this.leaderCtx : this.followers.get(profileId)?.context;
    const page = target && target.pages()[0];
    if (!page) return false;
    await setWindowState(target, page, 'normal');
    await page.bringToFront().catch(() => {});
    return true;
  }

  async setWindowLayout(layout, displayBounds = []) {
    if (!this.running) return this.status();
    const ids = ['leader', ...Array.from(this.followers.keys())];
    if (layout === 'last-used') return this.status();
    const plan = layout === 'minimized'
      ? minimizedPlan(displayBounds, ids)
      : tiledPlan(displayBounds, ids);
    await Promise.all(ids.map(async (id) => {
      const context = id === 'leader' ? this.leaderCtx : this.followers.get(id)?.context;
      const page = context && context.pages()[0];
      const bounds = plan.get(id);
      if (!context || !page || !bounds) return;
      await setWindowBounds(context, page, bounds);
    }));
    this._emitStatus();
    return this.status();
  }

  _trackLeaderPage(page) {
    if (!page) return;
    let state = this.leaderPages.get(page);
    if (state && state.tracked) return;
    state = state || {
      tracked: false,
      followers: new Map(),
      inputDebounce: new Map(),
      desiredUrl: null,
      suppressNavUntil: 0,
    };
    this.leaderPages.set(page, state);
    this.activeLeaderPage = page;
    for (const follower of this.followers.values()) this._ensurePair(state, follower.id);
    if (state.tracked) return;
    state.tracked = true;

    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        this.activeLeaderPage = page;
        this._syncNav(page, safeUrl(page));
        this._emitStatus();
      }
    });
    page.on('close', () => {
      const closed = this.leaderPages.get(page);
      this.leaderPages.delete(page);
      if (closed) {
        for (const pair of closed.followers.values()) {
          if (pair.page) pair.page.close().catch(() => {});
        }
      }
      if (this.activeLeaderPage === page) {
        this.activeLeaderPage = this.leaderCtx ? this.leaderCtx.pages()[0] || null : null;
      }
    });
  }

  _onLeaderPage(page) {
    this._trackLeaderPage(page);
    page.evaluate(installMirrorCapture).catch(() => {});
    for (const follower of this.followers.values()) this._ensurePair(this.leaderPages.get(page), follower.id);
  }

  _ensurePair(leaderState, followerId) {
    if (!leaderState) return null;
    if (!leaderState.followers.has(followerId)) {
      leaderState.followers.set(followerId, {
        followerId,
        page: null,
        preassigned: null,
        creating: null,
        navChain: Promise.resolve(),
        queue: [],
        queueDepth: 0,
        draining: false,
        desiredUrl: null,
        lastNavAt: 0,
      });
    }
    return leaderState.followers.get(followerId);
  }

  async _followerPair(leaderPage, followerId) {
    const leaderState = this.leaderPages.get(leaderPage);
    const follower = this.followers.get(followerId);
    if (!leaderState || !follower || follower.state !== 'ready' || !follower.context) return null;
    const pair = this._ensurePair(leaderState, followerId);
    if (pair.page && !pair.page.isClosed()) return pair;
    if (!pair.creating) {
      pair.creating = (async () => {
        let page = pair.preassigned;
        pair.preassigned = null;
        if (!page || page.isClosed()) page = await follower.context.newPage();
        pair.page = page;
        return pair;
      })().catch((error) => {
        follower.state = 'error';
        follower.lastError = shortErr(error);
        pair.creating = null;
        this._emitStatus();
        return null;
      });
    }
    return pair.creating;
  }

  async _reconcile() {
    if (this._reconciling || !this.running || !this.leaderCtx) return;
    this._reconciling = true;
    try {
      for (const page of this.leaderCtx.pages()) {
        this._trackLeaderPage(page);
        const url = safeUrl(page);
        if (url && /^https?:/.test(url)) {
          const installed = await page.evaluate(() => !!window.__mirrorCaptureInstalled).catch(() => false);
          if (!installed) await page.evaluate(installMirrorCapture).catch(() => {});
        }
        const leaderState = this.leaderPages.get(page);
        for (const follower of this.followers.values()) {
          if (follower.state === 'ready') await this._followerPair(page, follower.id);
          this._ensurePair(leaderState, follower.id);
        }
      }
    } finally {
      this._reconciling = false;
    }
  }

  _onEvent(leaderPage, dataStr, leaderFrame) {
    if (!this.running || !this.mirroring) return;
    let ev;
    try { ev = JSON.parse(dataStr); } catch (_) { return; }
    if (!leaderPage) return;
    this.activeLeaderPage = leaderPage;
    ev.__url = safeUrl(leaderPage);
    ev.__frameUrl = leaderFrame ? safeFrameUrl(leaderFrame) : null;
    if (isSensitiveChallengeUrl(ev.__url) || isSensitiveChallengeUrl(ev.__frameUrl)) {
      this.onLog({ level: 'warn', text: 'Security challenge action not mirrored; solve it separately in each profile.' });
      return;
    }

    const leaderState = this.leaderPages.get(leaderPage);
    if (!leaderState) return;
    if (ev.kind === 'nav') {
      if (ev.href && /^https?:/.test(ev.href)) this._syncNav(leaderPage, ev.href);
      return;
    }
    this.eventCount++;
    if (ev.kind === 'click' && ev.isSubmit) leaderState.suppressNavUntil = Date.now() + 3500;

    if (ev.kind === 'input' || ev.kind === 'text-op') {
      const key = (ev.selectors && ev.selectors[0]) || 'contenteditable';
      const prev = leaderState.inputDebounce.get(key);
      if (prev) {
        clearTimeout(prev.timer);
        if (ev.kind === 'text-op' && prev.ev && prev.ev.kind === 'text-op') {
          ev.valueBefore = prev.ev.valueBefore;
          ev.selectionBefore = prev.ev.selectionBefore;
        }
      }
      const timer = setTimeout(() => {
        leaderState.inputDebounce.delete(key);
        this._broadcastEvent(leaderPage, ev);
      }, INPUT_DEBOUNCE_MS);
      leaderState.inputDebounce.set(key, { timer, ev });
      this._emitStatus();
      return;
    }

    this._flushPendingInputs(leaderPage);
    this._broadcastEvent(leaderPage, ev);
    this._emitStatus();
  }

  _flushPendingInputs(leaderPage) {
    const state = this.leaderPages.get(leaderPage);
    if (!state) return;
    for (const [key, pending] of state.inputDebounce.entries()) {
      clearTimeout(pending.timer);
      state.inputDebounce.delete(key);
      this._broadcastEvent(leaderPage, pending.ev);
    }
  }

  _broadcastEvent(leaderPage, ev) {
    const state = this.leaderPages.get(leaderPage);
    if (!state) return;
    this._logEvent(ev);
    for (const follower of this.followers.values()) {
      if (follower.state !== 'ready') continue;
      const pair = this._ensurePair(state, follower.id);
      if (pair.queue.length >= MAX_QUEUE) {
        const removable = pair.queue.findIndex((queued) => queued.kind === 'scroll' || queued.kind === 'text-op');
        if (removable >= 0) pair.queue.splice(removable, 1);
        else {
          follower.state = 'degraded';
          follower.lastError = 'Follower queue is full.';
          continue;
        }
      }
      pair.queue.push({ ...ev });
      pair.queueDepth = pair.queue.length;
      follower.queueDepth = Array.from(this.leaderPages.values()).reduce(
        (sum, leaderState) => sum + (leaderState.followers.get(follower.id)?.queue.length || 0),
        0
      );
      this._drainPair(leaderPage, follower.id);
    }
  }

  async _drainPair(leaderPage, followerId) {
    const state = this.leaderPages.get(leaderPage);
    const follower = this.followers.get(followerId);
    const pair = state && state.followers.get(followerId);
    if (!state || !follower || !pair || pair.draining) return;
    pair.draining = true;
    try {
      while (pair.queue.length && this.running) {
        const ev = pair.queue.shift();
        pair.queueDepth = pair.queue.length;
        const resolvedPair = await this._followerPair(leaderPage, followerId);
        if (!resolvedPair || !resolvedPair.page) break;
        try {
          if (ev.__url) {
            await this._ensureFollowerUrl(leaderPage, followerId, ev.__url);
            if (this._isStaleEvent(pair, ev, resolvedPair.page)) continue;
          }
          const target = await this._replayTarget(resolvedPair.page, ev);
          await replayEvent(target, ev, this.settings);
        } catch (error) {
          if (!this._isStaleEvent(pair, ev, resolvedPair.page)) {
            follower.lastError = `replay ${ev.kind}: ${shortErr(error)}`;
            this.onLog({ level: 'error', text: `${follower.name}: ${follower.lastError}` });
          }
        }
      }
    } finally {
      pair.draining = false;
      follower.queueDepth = Array.from(this.leaderPages.values()).reduce(
        (sum, leaderState) => sum + (leaderState.followers.get(followerId)?.queue.length || 0),
        0
      );
      this._emitStatus();
    }
  }

  _syncNav(leaderPage, url) {
    if (!this.running || !this.mirroring || !url || !/^https?:/.test(url)) return;
    const state = this.leaderPages.get(leaderPage);
    if (state && state.suppressNavUntil && Date.now() < state.suppressNavUntil) return;
    for (const follower of this.followers.values()) {
      if (follower.state === 'ready') this._ensureFollowerUrl(leaderPage, follower.id, url);
    }
  }

  _ensureFollowerUrl(leaderPage, followerId, url) {
    if (!url || !/^https?:/.test(url)) return Promise.resolve();
    const state = this.leaderPages.get(leaderPage);
    const pair = state && this._ensurePair(state, followerId);
    if (!pair) return Promise.resolve();
    if (sameUrl(pair.desiredUrl, url) && Date.now() - pair.lastNavAt < NAV_RELOAD_COOLDOWN_MS) {
      return pair.navChain;
    }
    pair.desiredUrl = url;
    pair.navChain = pair.navChain.then(async () => {
      const resolvedPair = await this._followerPair(leaderPage, followerId);
      if (!resolvedPair || !resolvedPair.page || !sameUrl(pair.desiredUrl, url)) return;
      if (sameUrl(safeUrl(resolvedPair.page), url)) return;
      try {
        pair.lastNavAt = Date.now();
        await resolvedPair.page.goto(url, { timeout: 9000, waitUntil: 'commit' });
        await resolvedPair.page.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => {});
        const follower = this.followers.get(followerId);
        this.onLog({ level: 'info', text: `${follower ? follower.name : followerId} → ${shortUrl(url)}` });
      } catch (_) {}
    });
    return pair.navChain;
  }

  async _replayTarget(page, ev) {
    if (!ev || !ev.__frameUrl || !page || !/^https?:/.test(ev.__frameUrl)) return page;
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      for (const frame of page.frames()) {
        if (sameUrl(safeFrameUrl(frame), ev.__frameUrl)) return frame;
      }
      await sleep(75);
    }
    return page;
  }

  _isStaleEvent(pair, ev, followerPage) {
    if (!ev || !ev.__url || ev.kind === 'scroll' || !/^https?:/.test(ev.__url)) return false;
    if (pair && pair.desiredUrl && !sameUrl(pair.desiredUrl, ev.__url)) return true;
    return followerPage && !sameUrl(safeUrl(followerPage), ev.__url);
  }

  _onFollowerContextClosed(followerId) {
    const follower = this.followers.get(followerId);
    if (!follower || !this.running) return;
    follower.context = null;
    follower.state = 'closed';
    follower.lastError = 'Follower browser closed.';
    this.onLog({ level: 'warn', text: `${follower.name} closed — other followers remain active.` });
    this._emitStatus();
  }

  _onContextClosed(which) {
    if (!this.running) return;
    this.onLog({ level: 'warn', text: `${which} browser was closed — ending session.` });
    this.stop();
  }

  _logEvent(ev) {
    this.onLog({ level: 'event', text: describeEvent(ev) });
  }
}

async function setWindowState(context, page, state) {
  try {
    const cdp = await context.newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: state } });
    await cdp.detach().catch(() => {});
  } catch (_) {}
}

async function setWindowBounds(context, page, bounds) {
  try {
    const cdp = await context.newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds });
    await cdp.detach().catch(() => {});
  } catch (_) {}
}

function minimizedPlan(displays, ids) {
  const first = normalizeBounds((displays && displays[0]) || {});
  const map = new Map();
  const half = Math.max(480, Math.floor(first.width / 2));
  map.set(ids[0], {
    left: first.x,
    top: first.y,
    width: half,
    height: first.height,
    windowState: 'normal',
  });
  ids.slice(1).forEach((id) => map.set(id, {
    left: first.x,
    top: first.y,
    width: half,
    height: first.height,
    windowState: 'minimized',
  }));
  return map;
}

function tiledPlan(displays, ids) {
  const safeDisplays = (Array.isArray(displays) && displays.length ? displays : [{}]).map(normalizeBounds);
  const allocations = splitCount(ids.length, safeDisplays.length);
  const plan = new Map();
  let cursor = 0;

  safeDisplays.forEach((display, displayIndex) => {
    const count = allocations[displayIndex];
    if (!count) return;
    const cols = Math.max(1, Math.ceil(Math.sqrt(count * (display.width / display.height))));
    const rows = Math.max(1, Math.ceil(count / cols));
    const width = Math.floor(display.width / cols);
    const height = Math.floor(display.height / rows);
    for (let index = 0; index < count; index++) {
      const id = ids[cursor++];
      if (!id) break;
      plan.set(id, {
        left: display.x + (index % cols) * width,
        top: display.y + Math.floor(index / cols) * height,
        width: index % cols === cols - 1 ? display.width - (cols - 1) * width : width,
        height: Math.floor(index / cols) === rows - 1
          ? display.height - (rows - 1) * height
          : height,
        windowState: 'normal',
      });
    }
  });
  return plan;
}

function normalizeBounds(display) {
  const work = display && display.workArea ? display.workArea : display;
  return {
    x: Number(work.x) || 0,
    y: Number(work.y) || 0,
    width: Math.max(640, Number(work.width) || 1280),
    height: Math.max(480, Number(work.height) || 800),
  };
}

function splitCount(total, count) {
  const base = Math.floor(total / count);
  const remainder = total % count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

function describeEvent(ev) {
  const sel = (ev.selectors && ev.selectors[0]) || ev.tag || '';
  switch (ev.kind) {
    case 'click':
      return `click  ${sel}${ev.text ? `  "${ev.text.trim().slice(0, 24)}"` : ''}`;
    case 'input':
      return `type   ${sel} = ${ev.isPassword ? '••••••' : `"${(ev.value || '').slice(0, 28)}"`}`;
    case 'text-op':
      return `text   ${ev.inputType || 'edit'} ${sel}${ev.data ? ` = ${JSON.stringify(ev.data.slice(0, 24))}` : ''}`;
    case 'select':
      return `select ${sel} = ${ev.value}`;
    case 'check':
      return `${ev.checked ? 'check  ' : 'uncheck'} ${sel}`;
    case 'key':
      return `key    ${[ev.ctrl && 'Ctrl', ev.alt && 'Alt', ev.shift && 'Shift', ev.meta && 'Meta', ev.key].filter(Boolean).join('+')}`;
    case 'scroll':
      return `scroll ${ev.y}px`;
    default:
      return ev.kind;
  }
}

function safeUrl(page) {
  try { return page.url(); } catch (_) { return null; }
}
function safeFrameUrl(frame) {
  try { return frame.url(); } catch (_) { return null; }
}
function shortUrl(value) {
  try {
    const url = new URL(value);
    return (url.host + url.pathname).slice(0, 48);
  } catch (_) {
    return String(value).slice(0, 48);
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
function shortErr(error) {
  return String((error && error.message) || error).split('\n')[0].slice(0, 140);
}
function isSensitiveChallengeUrl(url) {
  if (!url) return false;
  const value = String(url).toLowerCase();
  return value.includes('challenges.cloudflare.com')
    || value.includes('/cdn-cgi/challenge-platform/')
    || value.includes('captcha')
    || value.includes('turnstile');
}
function escapeHtml(value) {
  return String(value || '').replace(/[&<>"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[char]));
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { MirrorEngine, describeEvent, minimizedPlan, tiledPlan };
