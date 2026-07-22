'use strict';

const { chromium } = require('playwright-core');
const installMirrorCapture = require('./capture-script');
const { cleanProfileSessionRestore } = require('./profile-hygiene');
const { replayEvent } = require('./replay');

const LAUNCH_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-session-crashed-bubble',
  '--hide-crash-restore-bubble',
];

// One display frame is enough to combine browser input/input-like events while
// keeping typing visibly immediate. The final value/delta is still preserved.
const INPUT_DEBOUNCE_MS = 16;
const STATUS_UPDATE_DEBOUNCE_MS = 40;
const NAV_RELOAD_COOLDOWN_MS = 1200;
const MAX_QUEUE = 2000;
const FOLLOWER_LAUNCH_BATCH = 3;
const FOLLOWER_RETRY_DELAYS_MS = [750, 1500, 3000, 5000, 10_000];

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
    ? 'Type below for an instant mirror check, or open any website.'
    : `Profile: ${safeName} · this field should match the Leader.`;
  return (
    'data:text/html,' +
    encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><title>Chrome Mirror</title>
<style>*{box-sizing:border-box}html,body{margin:0;height:100%}
body{display:grid;place-items:center;background:radial-gradient(circle at 20% 10%,#e5f2ff 0,transparent 38%),linear-gradient(145deg,#f7faff,#edf3fa);font-family:-apple-system,"Segoe UI",Roboto,sans-serif;color:#142033;padding:24px}
.card{max-width:620px;width:100%;background:rgba(255,255,255,.94);border:1px solid #dce4ef;border-radius:22px;padding:42px;box-shadow:0 18px 50px rgba(18,45,78,.14);text-align:center}
.badge{display:inline-block;font-size:12px;font-weight:700;letter-spacing:.4px;padding:6px 13px;border-radius:999px;margin-bottom:18px}
.badge.lead{background:#e8f0ff;color:#1554b5}.badge.fol{background:#e6f8f4;color:#087f69}
h1{font-size:26px;margin:0 0 10px}p{color:#637087;font-size:15px;line-height:1.6;margin:0 0 24px}
.test{position:relative;text-align:left}.test label{display:block;margin:0 0 8px;font-size:12px;font-weight:700;color:#42526a}.test input{width:100%;height:50px;border:1px solid #c9d5e5;border-radius:12px;padding:0 44px 0 15px;font:500 15px/1.2 inherit;color:#142033;background:#fbfdff;outline:none;transition:.15s}.test input:focus{border-color:#3478d4;box-shadow:0 0 0 4px rgba(52,120,212,.12)}.check{position:absolute;right:14px;bottom:16px;color:#0b9a78;font-weight:800}.hint{margin-top:14px;font-size:13px;color:#7d899c}</style></head>
<body><div class="card">${badge}<h1>${head}</h1><p>${body}</p><div class="test"><label for="mirror-test-input">Live typing test</label><input id="mirror-test-input" autocomplete="off" spellcheck="false" placeholder="Type here to test mirroring…"><span class="check">✓</span></div><div class="hint">${hint}</div></div></body></html>`)
  );
}

function installFollowerBadge() {
  if (!window.__mirrorFollowerPopupGuard) {
    window.__mirrorFollowerPopupGuard = true;
    try {
      window.open = function () { return null; };
    } catch (_) {}

    function popupTarget(node) {
      try {
        while (node && node.nodeType === 1) {
          var tag = String(node.tagName || '').toLowerCase();
          if (tag === 'a' || tag === 'area' || tag === 'form') {
            var target = String(node.getAttribute('target') || '').toLowerCase();
            if (target && target !== '_self' && target !== '_top' && target !== '_parent') return node;
          }
          node = node.parentElement;
        }
      } catch (_) {}
      return null;
    }

    function blockPopupDefault(event) {
      if (popupTarget(event.target)) event.preventDefault();
    }

    document.addEventListener('click', blockPopupDefault, true);
    document.addEventListener('auxclick', blockPopupDefault, true);
    document.addEventListener('submit', blockPopupDefault, true);
  }

  if (window.__mirrorBadge) return;
  function add() {
    if (!document.body || document.getElementById('__cm_badge')) return;
    var b = document.createElement('div');
    b.id = '__cm_badge';
    // This is also a live ownership marker: forked/local sessions do not
    // execute this official main-app engine.
    b.textContent = '● OFFICIAL MIRROR';
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
    this._statusTimer = null;
    this._mirrorEpoch = 0;
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
        tabs: f.context && typeof f.context.pages === 'function' ? f.context.pages().length : 0,
        queueDepth: f.queueDepth,
        lastError: f.lastError,
        replayFailures: f.replayFailures || 0,
        lastLatencyMs: f.lastLatencyMs || 0,
      })),
    };
  }

  _emitStatus() {
    this.onStatus(this.status());
  }

  _scheduleStatus() {
    if (this._statusTimer) return;
    this._statusTimer = setTimeout(() => {
      this._statusTimer = null;
      this._emitStatus();
    }, STATUS_UPDATE_DEBOUNCE_MS);
    if (typeof this._statusTimer.unref === 'function') this._statusTimer.unref();
  }

  _prepareManagedProfileForLaunch(label, profile) {
    if (!profile || !profile.dir) return;
    this.onLog({ level: 'info', text: `${label} controlled profile: ${profile.dir}` });
    try {
      const result = cleanProfileSessionRestore(profile.dir);
      if (result.cleaned.length) {
        this.onLog({
          level: 'warn',
          text: `${label}: cleared saved Chrome tabs/session before launch; backup: ${result.backupDir}`,
        });
      }
    } catch (error) {
      this.onLog({
        level: 'warn',
        text: `${label}: could not clear saved Chrome session before launch (${shortErr(error)}).`,
      });
    }
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

    this._prepareManagedProfileForLaunch('Leader', leaderProfile);
    for (const profile of followerProfiles) this._prepareManagedProfileForLaunch(profile.name || 'Follower', profile);

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
    this.activeLeaderPage = firstLeader;

    for (const profile of followerProfiles) {
      this.followers.set(profile.id, {
        id: profile.id,
        name: profile.name,
        profile,
        context: null,
        state: 'launching',
        queueDepth: 0,
        lastError: null,
        replayFailures: 0,
        lastLatencyMs: 0,
        restartAttempts: 0,
        retryTimer: null,
      });
    }
    this.running = true;
    this.mirroring = true;
    this._mirrorEpoch += 1;
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
      follower.pendingPages = [];
      follower.ownedPages = new Set();
      follower.guardedPages = new Set();
      follower.ownedPageCreations = new Set();
      follower.recoveringPages = new Set();
      follower.lastPruneAt = 0;
      await context.addInitScript(installFollowerBadge);
      context.on('close', () => this._onFollowerContextClosed(profile.id, context));
      const restoredPages = context.pages();
      let firstPage = restoredPages.find((page) => !isFollowerHelperTopLevelUrl(safeUrl(page))) || null;
      if (!firstPage) firstPage = await context.newPage();
      this._registerOwnedFollowerPage(follower, firstPage);
      context.on('page', (page) => this._onFollowerPage(profile.id, page));
      for (const leaderPage of this.leaderPages.keys()) {
        const leaderState = this.leaderPages.get(leaderPage);
        const pair = this._ensurePair(leaderState, profile.id);
        if (leaderPage === this.activeLeaderPage && !pair.page && !pair.preassigned) {
          pair.preassigned = firstPage;
        }
      }
      await this._pruneFollowerPages(follower, 'startup');
      follower.restartAttempts = 0;
      this.launchProgress.completed++;
      this.onLog({ level: 'info', text: `${profile.name} is ready.` });
    } catch (error) {
      follower.state = 'error';
      follower.lastError = shortErr(error);
      this.launchProgress.completed++;
      this.onLog({ level: 'error', text: `${profile.name} failed to launch: ${follower.lastError}` });
      if (this.running && !follower.restarting) {
        this._scheduleFollowerRecovery(profile.id, follower.lastError);
      }
    }
  }

  async retryFollower(profileId) {
    if (!this.running || !this._startOptions) return this.status();
    const follower = this.followers.get(profileId);
    if (!follower) return this.status();
    follower.restartAttempts = 0;
    await this._restartFollower(profileId, 'manual retry');
    this._emitStatus();
    return this.status();
  }

  async _restartFollower(profileId, reason = 'automatic recovery') {
    if (!this.running || !this._startOptions) return false;
    const follower = this.followers.get(profileId);
    if (!follower || follower.restarting) return false;
    follower.restarting = true;
    if (follower.retryTimer) clearTimeout(follower.retryTimer);
    follower.retryTimer = null;
    const oldContext = follower.context;
    follower.context = null;
    for (const leaderState of this.leaderPages.values()) {
      const pair = leaderState.followers.get(profileId);
      if (!pair) continue;
      pair.page = null;
      pair.preassigned = null;
      pair.creating = null;
      pair.navChain = Promise.resolve();
      pair.generation = (pair.generation || 0) + 1;
    }
    follower.state = 'launching';
    follower.lastError = `${reason}; reconnecting…`;
    this._emitStatus();
    try { if (oldContext) await oldContext.close(); } catch (_) {}
    try {
      this._prepareManagedProfileForLaunch(follower.name || 'Follower', follower.profile);
      const baseOpts = {
        headless: this._startOptions.headless,
        viewport: null,
        chromiumSandbox: true,
      };
      if (this._startOptions.executablePath) baseOpts.executablePath = this._startOptions.executablePath;
      else baseOpts.channel = 'chrome';
      await this._launchFollower(
        follower.profile,
        baseOpts,
        this._startOptions.followerArgs.get(profileId) || []
      );
      if (follower.state === 'ready') await this._resyncFollower(profileId);
      return follower.state === 'ready';
    } finally {
      follower.restarting = false;
      if (this.running && follower.state !== 'ready') {
        this._scheduleFollowerRecovery(profileId, follower.lastError || 'launch failed');
      }
    }
  }

  async _resyncFollower(profileId) {
    const follower = this.followers.get(profileId);
    if (!follower || follower.state !== 'ready') return;
    const syncs = [];
    for (const leaderPage of this.leaderPages.keys()) {
      const url = safeUrl(leaderPage);
      if (url && /^https?:/.test(url)) syncs.push(this._ensureFollowerUrl(leaderPage, profileId, url));
      else if (leaderPage === this.activeLeaderPage && url && url.startsWith('data:text/html,')) {
        syncs.push((async () => {
          const pair = await this._followerPair(leaderPage, profileId);
          if (pair && pair.page) await pair.page.goto(startPage('follower', follower.name)).catch(() => {});
        })());
      }
    }
    await Promise.allSettled(syncs);
    if (this.activeLeaderPage) {
      const state = this.leaderPages.get(this.activeLeaderPage);
      const pair = state && state.followers.get(profileId);
      const page = pair && (pair.page || pair.preassigned);
      if (page) await this._activateFollowerPageIfCurrentLeader(this.activeLeaderPage, page);
    }
  }

  _scheduleFollowerRecovery(profileId, reason) {
    const follower = this.followers.get(profileId);
    if (!this.running || !follower || follower.retryTimer || follower.restarting) return;
    const attempt = Math.min(follower.restartAttempts || 0, FOLLOWER_RETRY_DELAYS_MS.length - 1);
    const delay = FOLLOWER_RETRY_DELAYS_MS[attempt];
    follower.restartAttempts = (follower.restartAttempts || 0) + 1;
    follower.state = 'recovering';
    follower.lastError = `${reason}; retrying in ${Math.ceil(delay / 1000)}s`;
    follower.retryTimer = setTimeout(() => {
      follower.retryTimer = null;
      this._restartFollower(profileId, 'automatic recovery').catch((error) => {
        follower.lastError = shortErr(error);
        this._scheduleFollowerRecovery(profileId, follower.lastError);
      });
    }, delay);
    if (follower.retryTimer.unref) follower.retryTimer.unref();
    this.onLog({ level: 'warn', text: `${follower.name}: ${follower.lastError}` });
    this._emitStatus();
  }

  async _initializeStartPages(firstLeader) {
    const leaderPages = this.leaderCtx && typeof this.leaderCtx.pages === 'function'
      ? this.leaderCtx.pages()
      : [firstLeader].filter(Boolean);
    const startupSyncs = [];
    for (const leaderPage of leaderPages) {
      this._trackLeaderPage(leaderPage);
      const url = safeUrl(leaderPage);
      const isFirstBlank = leaderPage === firstLeader
        && (!url || url === 'about:blank' || url.startsWith('chrome://') || url.startsWith('chrome-error'));
      if (isFirstBlank) {
        await firstLeader.goto(startPage('leader', 'Leader')).catch(() => {});
        startupSyncs.push(...Array.from(this.followers.values()).map(async (follower) => {
          if (!isFollowerOperational(follower)) return;
          const pair = await this._followerPair(firstLeader, follower.id);
          if (pair && pair.page) await pair.page.goto(startPage('follower', follower.name)).catch(() => {});
        }));
      } else if (url && /^https?:/.test(url)) {
        startupSyncs.push(this._syncNav(leaderPage, url));
      }
    }
    await Promise.allSettled(startupSyncs);
    await Promise.all(Array.from(this.followers.values()).map((follower) =>
      this._pruneFollowerPages(follower, 'startup')
    ));
  }

  async stop() {
    if (!this.running && !this.leaderCtx && !this.followers.size) return;
    this.running = false;
    this.mirroring = false;
    if (this._poll) clearInterval(this._poll);
    this._poll = null;
    if (this._statusTimer) clearTimeout(this._statusTimer);
    this._statusTimer = null;

    for (const leaderState of this.leaderPages.values()) {
      for (const pending of leaderState.inputDebounce.values()) clearTimeout(pending.timer);
      leaderState.inputDebounce.clear();
      for (const pair of leaderState.followers.values()) {
        pair.queue = [];
        pair.queueDepth = 0;
      }
    }

    const leader = this.leaderCtx;
    const followerStates = Array.from(this.followers.values());
    for (const follower of followerStates) {
      if (follower.retryTimer) clearTimeout(follower.retryTimer);
      follower.retryTimer = null;
    }
    const followers = followerStates.map((f) => f.context).filter(Boolean);
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

  async setMirroring(on) {
    if (!this.running) return this.status();
    const enabled = !!on;
    if (enabled === this.mirroring) return this.status();

    // Invalidate work that was captured before this state transition. The
    // epoch also prevents an event that was already awaiting a slow follower
    // from replaying after a quick pause/resume cycle.
    this._mirrorEpoch += 1;
    this.mirroring = enabled;

    if (!enabled) {
      this._discardPendingMirrorWork();
      this.onLog({
        level: 'info',
        text: 'Mirroring paused — browser windows and tab pairs remain open.',
      });
      this._emitStatus();
      return this.status();
    }

    // The leader may have navigated or changed tabs while paused. Catch the
    // currently selected pair up before accepting further user actions.
    const leaderPage = this.activeLeaderPage
      || (this.leaderCtx && this.leaderCtx.pages()[0])
      || null;
    if (leaderPage) await this._activateLeaderPage(leaderPage);
    this.onLog({ level: 'info', text: 'Mirroring resumed — current leader tab is synchronized.' });
    this._emitStatus();
    return this.status();
  }

  _discardPendingMirrorWork() {
    for (const leaderState of this.leaderPages.values()) {
      for (const pending of leaderState.inputDebounce.values()) clearTimeout(pending.timer);
      leaderState.inputDebounce.clear();
      for (const pair of leaderState.followers.values()) {
        pair.queue = [];
        pair.queueDepth = 0;
      }
    }
    for (const follower of this.followers.values()) follower.queueDepth = 0;
  }

  async focusProfile(profileId) {
    const target = profileId === 'leader' ? this.leaderCtx : this.followers.get(profileId)?.context;
    let page = profileId === 'leader' ? this.activeLeaderPage : null;
    if (profileId !== 'leader' && this.activeLeaderPage) {
      const state = this.leaderPages.get(this.activeLeaderPage);
      const pair = state && state.followers.get(profileId);
      page = pair && (pair.page || pair.preassigned);
    }
    if (!page && target && typeof target.pages === 'function') page = target.pages()[0];
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
      lastPageInteractionAt: 0,
      speculativeNavigation: null,
      createdAt: Date.now(),
    };
    this.leaderPages.set(page, state);
    if (!this.activeLeaderPage) this.activeLeaderPage = page;
    for (const follower of this.followers.values()) this._ensurePair(state, follower.id);
    if (state.tracked) return;
    state.tracked = true;

    // Browser-UI navigation (address bar, back/forward, bookmarks) is not a
    // DOM event, so waiting for the leader's commit makes the two network
    // loads sequential. Start safe top-level GETs in followers as soon as the
    // leader issues the request. Page clicks are excluded because their
    // trusted replay already starts follower navigation in parallel.
    page.on('request', (request) => {
      try {
        if (!this.running || !this.mirroring) return;
        if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
        if (String(request.method()).toUpperCase() !== 'GET') return;
        if (typeof request.redirectedFrom === 'function' && request.redirectedFrom()) return;
        if (Date.now() - Number(state.lastPageInteractionAt || 0) < 750) return;
        const targetUrl = request.url();
        if (!/^https?:/.test(targetUrl)) return;
        state.speculativeNavigation = {
          request,
          previousUrl: safeUrl(page),
          targetUrl,
        };
        this._syncNav(page, targetUrl);
      } catch (_) {}
    });
    page.on('requestfailed', (request) => {
      this._rollbackSpeculativeNavigation(page, state, request);
    });
    page.on('response', (response) => {
      try {
        const request = response.request();
        const speculative = state.speculativeNavigation;
        if (!speculative || speculative.request !== request) return;
        const disposition = String(response.headers()['content-disposition'] || '').toLowerCase();
        if (response.status() === 204 || response.status() === 205 || disposition.includes('attachment')) {
          this._rollbackSpeculativeNavigation(page, state, request);
        }
      } catch (_) {}
    });

    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        state.speculativeNavigation = null;
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

  _rollbackSpeculativeNavigation(page, state, request) {
    const speculative = state && state.speculativeNavigation;
    if (!speculative || speculative.request !== request) return;
    state.speculativeNavigation = null;
    const currentUrl = safeUrl(page);
    const rollbackUrl = currentUrl && /^https?:/.test(currentUrl)
      ? currentUrl
      : speculative.previousUrl;
    if (rollbackUrl && /^https?:/.test(rollbackUrl)) this._syncNav(page, rollbackUrl);
  }

  async _activateLeaderPage(leaderPage) {
    const state = this.leaderPages.get(leaderPage);
    if (!state || !this.running) return;
    this.activeLeaderPage = leaderPage;
    const leaderUrl = safeUrl(leaderPage);
    await Promise.allSettled(Array.from(this.followers.values()).map(async (follower) => {
      if (!isFollowerOperational(follower)) return;
      const pair = await this._followerPair(leaderPage, follower.id);
      if (!pair || !pair.page || this.activeLeaderPage !== leaderPage) return;
      if (leaderUrl && /^https?:/.test(leaderUrl) && !sameUrl(safeUrl(pair.page), leaderUrl)) {
        await this._ensureFollowerUrl(leaderPage, follower.id, leaderUrl);
        return;
      }
      await this._activateFollowerPageIfCurrentLeader(leaderPage, pair.page);
    }));
    this._scheduleStatus();
  }

  _onLeaderPage(page) {
    this._trackLeaderPage(page);
    page.evaluate(installMirrorCapture).catch(() => {});
    const state = this.leaderPages.get(page);
    for (const follower of this.followers.values()) {
      this._ensurePair(state, follower.id);
      if (!isFollowerOperational(follower)) continue;
      this._followerPair(page, follower.id).then((pair) => {
        const url = safeUrl(page);
        if (pair && pair.page && url && /^https?:/.test(url)) {
          this._ensureFollowerUrl(page, follower.id, url).catch(() => {});
        }
      }).catch(() => {});
    }
  }

  _onFollowerPage(followerId, page) {
    const follower = this.followers.get(followerId);
    if (!follower || !page) return;
    if (this._isFollowerPageOwned(follower, page) || this._isFollowerPageAssigned(followerId, page)) {
      this._registerOwnedFollowerPage(follower, page);
      return;
    }
    if (!Array.isArray(follower.pendingPages)) follower.pendingPages = [];
    if (follower.pendingPages.some((entry) => entry.page === page)) return;

    const entry = {
      page,
      opener: null,
      createdAt: Date.now(),
      openerReady: Promise.resolve()
        .then(() => (typeof page.opener === 'function' ? page.opener() : null))
        .then((opener) => {
          entry.opener = opener || null;
          return entry.opener;
        })
        .catch(() => null),
    };
    follower.pendingPages.push(entry);
    entry.ownershipReady = entry.openerReady
      .then(() => this._quarantineFollowerPage(follower, entry, 'popup'))
      .catch(() => false);
    if (typeof page.on === 'function') page.on('close', () => this._dropPendingFollowerPage(follower, page));
  }

  _isFollowerPageAssigned(followerId, page) {
    for (const leaderState of this.leaderPages.values()) {
      const pair = leaderState.followers.get(followerId);
      if (pair && (pair.page === page || pair.preassigned === page)) return true;
    }
    return false;
  }

  _findFollowerPageAssignment(followerId, page) {
    for (const [leaderPage, leaderState] of this.leaderPages.entries()) {
      const pair = leaderState.followers.get(followerId);
      if (pair && (pair.page === page || pair.preassigned === page)) {
        return { leaderPage, leaderState, pair };
      }
    }
    return null;
  }

  _isFollowerPageOwned(follower, page) {
    return !!(follower && follower.ownedPages instanceof Set && follower.ownedPages.has(page));
  }

  _registerOwnedFollowerPage(follower, page) {
    if (!follower || !page) return page;
    if (!(follower.ownedPages instanceof Set)) follower.ownedPages = new Set();
    if (!(follower.guardedPages instanceof Set)) follower.guardedPages = new Set();
    follower.ownedPages.add(page);
    this._dropPendingFollowerPage(follower, page);
    if (follower.guardedPages.has(page) || typeof page.on !== 'function') return page;
    follower.guardedPages.add(page);
    page.on('close', () => {
      follower.ownedPages.delete(page);
      follower.guardedPages.delete(page);
      this._dropPendingFollowerPage(follower, page);
    });
    page.on('framenavigated', (frame) => {
      const isMainFrame = typeof page.mainFrame !== 'function' || frame === page.mainFrame();
      const frameUrl = isMainFrame ? (safeFrameUrl(frame) || safeUrl(page)) : null;
      if (isMainFrame && isFollowerHelperTopLevelUrl(frameUrl)) {
        this._recoverAssignedFollowerHelper(follower, page, frameUrl).catch(() => {});
      }
    });
    return page;
  }

  async _createOwnedFollowerPage(follower) {
    if (!follower || !follower.context || typeof follower.context.newPage !== 'function') return null;
    if (!(follower.ownedPageCreations instanceof Set)) follower.ownedPageCreations = new Set();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    follower.ownedPageCreations.add(gate);
    try {
      const page = await follower.context.newPage();
      return this._registerOwnedFollowerPage(follower, page);
    } finally {
      release();
      follower.ownedPageCreations.delete(gate);
    }
  }

  _dropPendingFollowerPage(follower, page) {
    if (!follower || !Array.isArray(follower.pendingPages)) return;
    follower.pendingPages = follower.pendingPages.filter((entry) => entry.page !== page);
  }

  _pendingFollowerEntry(follower, page) {
    if (!follower || !Array.isArray(follower.pendingPages)) return null;
    return follower.pendingPages.find((entry) => entry.page === page) || null;
  }

  async _quarantineFollowerPage(follower, entry, reason = 'runtime') {
    if (!follower || !entry || !entry.page) return false;
    const page = entry.page;
    const creations = follower.ownedPageCreations instanceof Set
      ? Array.from(follower.ownedPageCreations)
      : [];
    if (creations.length) await Promise.allSettled(creations);
    if (
      this._isFollowerPageOwned(follower, page)
      || this._isFollowerPageAssigned(follower.id, page)
    ) {
      this._dropPendingFollowerPage(follower, page);
      return false;
    }
    if (typeof page.isClosed === 'function' && page.isClosed()) {
      this._dropPendingFollowerPage(follower, page);
      return false;
    }

    const url = safeUrl(page);
    const livePages = follower.context && typeof follower.context.pages === 'function'
      ? follower.context.pages().filter((candidate) =>
        candidate && !(typeof candidate.isClosed === 'function' && candidate.isClosed())
      )
      : [];
    if (livePages.length <= 1 && this.activeLeaderPage) {
      const replacement = await this._followerPair(this.activeLeaderPage, follower.id).catch(() => null);
      if (!replacement || !replacement.page || replacement.page === page) return false;
    }

    await page.close().catch(() => {});
    this._dropPendingFollowerPage(follower, page);
    const activeState = this.activeLeaderPage && this.leaderPages.get(this.activeLeaderPage);
    const activePair = activeState && activeState.followers.get(follower.id);
    const activePage = activePair && (activePair.page || activePair.preassigned);
    if (activePage && activePage !== page) {
      await this._activateFollowerPageIfCurrentLeader(this.activeLeaderPage, activePage);
    }
    this.onLog({
      level: 'warn',
      text: `${follower.name}: quarantined unowned follower tab (${reason}) ${shortUrl(url)}`,
    });
    return true;
  }

  async _pruneFollowerPages(follower, reason = 'runtime') {
    if (!follower || !follower.context || follower.pruningPages) return;
    follower.pruningPages = true;
    try {
      const pages = follower.context.pages ? follower.context.pages() : [];
      for (const page of pages) {
        if (!page || (typeof page.isClosed === 'function' && page.isClosed())) continue;
        if (this._isFollowerPageAssigned(follower.id, page)) continue;
        if (this._isFollowerPageOwned(follower, page)) continue;
        const entry = this._pendingFollowerEntry(follower, page) || {
          page,
          opener: null,
          createdAt: Date.now(),
          openerReady: Promise.resolve(null),
        };
        await this._quarantineFollowerPage(follower, entry, reason);
      }
    } finally {
      follower.pruningPages = false;
    }
  }

  async _activateFollowerPageIfCurrentLeader(leaderPage, page) {
    if (!page || leaderPage !== this.activeLeaderPage) return;
    if (typeof page.bringToFront !== 'function') return;
    await page.bringToFront().catch(() => {});
  }

  async _recoverAssignedFollowerHelper(follower, page, urlHint = null) {
    const helperUrl = urlHint || safeUrl(page);
    if (!follower || !page || !isFollowerHelperTopLevelUrl(helperUrl)) return false;
    if (!(follower.ownedPages instanceof Set)) follower.ownedPages = new Set();
    const assignment = this._findFollowerPageAssignment(follower.id, page);
    if (!assignment) {
      if (!this._isFollowerPageOwned(follower, page)) {
        return this._quarantineFollowerPage(follower, { page }, 'helper');
      }
      return false;
    }
    if (!(follower.recoveringPages instanceof Set)) follower.recoveringPages = new Set();
    if (follower.recoveringPages.has(page)) return false;
    follower.recoveringPages.add(page);
    const { leaderPage, pair } = assignment;
    try {
      if (pair.creating) await pair.creating.catch(() => null);
      if (pair.page !== page && pair.preassigned !== page) return false;
      const badUrl = helperUrl || safeUrl(page);
      const replacementPage = liveContextPages(follower.context).length <= 1
        ? await this._createOwnedFollowerPage(follower).catch(() => null)
        : null;
      if (pair.page === page) pair.page = replacementPage || null;
      if (pair.preassigned === page) pair.preassigned = null;
      pair.pageSource = replacementPage ? 'engine' : null;
      pair.generation = (pair.generation || 0) + 1;
      pair.lastCorrectionKey = null;
      follower.ownedPages.delete(page);
      await page.close().catch(() => {});
      this.onLog({
        level: 'warn',
        text: `${follower.name}: replaced unsafe assigned helper tab ${shortUrl(badUrl)}`,
      });
      const replacement = replacementPage ? pair : await this._followerPair(leaderPage, follower.id);
      const desiredUrl = pair.desiredUrl || safeUrl(leaderPage);
      if (replacement && replacement.page && desiredUrl && /^https?:/.test(desiredUrl)) {
        await this._ensureFollowerUrl(leaderPage, follower.id, desiredUrl);
      }
      return true;
    } finally {
      follower.recoveringPages.delete(page);
    }
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
        lastCorrectionKey: null,
        pageSource: null,
        generation: 0,
      });
    }
    return leaderState.followers.get(followerId);
  }

  async _followerPair(leaderPage, followerId) {
    const leaderState = this.leaderPages.get(leaderPage);
    const follower = this.followers.get(followerId);
    if (!leaderState || !follower || !isFollowerOperational(follower) || !follower.context) return null;
    if (!(follower.ownedPages instanceof Set)) follower.ownedPages = new Set();
    if (!(follower.ownedPageCreations instanceof Set)) follower.ownedPageCreations = new Set();
    const pair = this._ensurePair(leaderState, followerId);
    const currentPageOpen = pair.page
      && !(typeof pair.page.isClosed === 'function' && pair.page.isClosed());
    if (currentPageOpen && !isFollowerHelperTopLevelUrl(safeUrl(pair.page))) {
      this._registerOwnedFollowerPage(follower, pair.page);
      return pair;
    }
    if (currentPageOpen) {
      const unsafePage = pair.page;
      const unsafeUrl = safeUrl(unsafePage);
      const replacement = liveContextPages(follower.context).length <= 1
        ? await this._createOwnedFollowerPage(follower).catch(() => null)
        : null;
      pair.page = replacement || null;
      pair.pageSource = replacement ? 'engine' : null;
      pair.generation = (pair.generation || 0) + 1;
      follower.ownedPages.delete(unsafePage);
      await unsafePage.close().catch(() => {});
      this.onLog({
        level: 'warn',
        text: `${follower.name}: discarded unsafe canonical follower tab ${shortUrl(unsafeUrl)}`,
      });
      if (replacement) return pair;
    }
    if (!pair.creating) {
      pair.creating = (async () => {
        let page = pair.preassigned;
        let pageSource = page ? 'preassigned' : null;
        pair.preassigned = null;
        if (
          page
          && !(typeof page.isClosed === 'function' && page.isClosed())
          && isFollowerHelperTopLevelUrl(safeUrl(page))
        ) {
          follower.ownedPages.delete(page);
          await page.close().catch(() => {});
          page = null;
          pageSource = null;
        }
        if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
          page = await this._createOwnedFollowerPage(follower);
          pageSource = 'engine';
        }
        if (!page) throw new Error('Could not create a deterministic follower tab.');
        this._registerOwnedFollowerPage(follower, page);
        pair.page = page;
        pair.pageSource = pageSource;
        pair.generation = (pair.generation || 0) + 1;
        pair.creating = null;
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
      const syncs = [];
      for (const page of this.leaderCtx.pages()) {
        this._trackLeaderPage(page);
        const url = safeUrl(page);
        if (url && /^https?:/.test(url)) {
          const installed = await page.evaluate(() => !!document.__mirrorCaptureInstalled).catch(() => false);
          if (!installed) await page.evaluate(installMirrorCapture).catch(() => {});
        }
        const leaderState = this.leaderPages.get(page);
        for (const follower of this.followers.values()) {
          this._ensurePair(leaderState, follower.id);
          if (isFollowerOperational(follower)) {
            syncs.push((async () => {
              const pair = leaderState && leaderState.followers.get(follower.id);
              if (pair && pair.page && isFollowerHelperTopLevelUrl(safeUrl(pair.page))) {
                await this._recoverAssignedFollowerHelper(follower, pair.page);
              }
              if (
                pair
                && !pair.desiredUrl
                && !pair.page
                && !pair.preassigned
                && !pair.creating
                && url
                && /^https?:/.test(url)
              ) {
                await this._ensureFollowerUrl(page, follower.id, url);
              }
            })());
          }
        }
      }
      await Promise.allSettled(syncs);
      await Promise.allSettled(Array.from(this.followers.values()).map((follower) =>
        isFollowerOperational(follower) ? this._pruneFollowerPages(follower, 'runtime') : Promise.resolve()
      ));
    } finally {
      this._reconciling = false;
    }
  }

  _onEvent(leaderPage, dataStr, leaderFrame) {
    if (!this.running) return;
    let ev;
    try { ev = JSON.parse(dataStr); } catch (_) { return; }
    if (!leaderPage) return;
    ev.__url = safeUrl(leaderPage);
    ev.__frameUrl = leaderFrame ? safeFrameUrl(leaderFrame) : null;
    const mainFrame = typeof leaderPage.mainFrame === 'function'
      ? leaderPage.mainFrame()
      : null;
    ev.__mainFrame = !!(leaderFrame && mainFrame && leaderFrame === mainFrame);
    const leaderState = this.leaderPages.get(leaderPage);
    if (!leaderState) return;
    if (ev.kind === 'tab-activate') {
      if (!leaderFrame || !mainFrame || leaderFrame !== mainFrame) return;
      // Remember foreground ownership even while paused, but do not move or
      // navigate any follower until the user explicitly resumes.
      this.activeLeaderPage = leaderPage;
      if (this.mirroring) this._activateLeaderPage(leaderPage).catch(() => {});
      else this._scheduleStatus();
      return;
    }
    if (!this.mirroring) return;
    if (isSensitiveChallengeUrl(ev.__url) || isSensitiveChallengeUrl(ev.__frameUrl)) {
      this.onLog({ level: 'warn', text: 'Security challenge action not mirrored; solve it separately in each profile.' });
      return;
    }
    if (ev.kind === 'nav') {
      // Defense in depth: addInitScript executes in every frame. Only the
      // leader page's main frame is allowed to change a follower's top-level
      // URL; child-frame SPA navigation is replayed only as frame activity.
      if (!leaderFrame || !mainFrame || leaderFrame !== mainFrame) return;
      if (ev.href && /^https?:/.test(ev.href)) this._syncNav(leaderPage, ev.href);
      return;
    }
    if (this.activeLeaderPage !== leaderPage) {
      // Visibility is the primary signal; a trusted user event is a fallback
      // for pages that suppress or delay visibility/focus delivery.
      this._activateLeaderPage(leaderPage).catch(() => {});
    }
    this.eventCount++;
    leaderState.lastPageInteractionAt = Date.now();
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
      this._scheduleStatus();
      return;
    }

    this._flushPendingInputs(leaderPage);
    this._broadcastEvent(leaderPage, ev);
    this._scheduleStatus();
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
    if (!this.running || !this.mirroring) return;
    const state = this.leaderPages.get(leaderPage);
    if (!state) return;
    ev = { ...ev, __mirrorEpoch: this._mirrorEpoch };
    this._logEvent(ev);
    for (const follower of this.followers.values()) {
      if (!isFollowerOperational(follower)) continue;
      const pair = this._ensurePair(state, follower.id);
      if (coalesceQueuedEvent(pair.queue, ev)) {
        pair.queueDepth = pair.queue.length;
        continue;
      }
      if (pair.queue.length >= MAX_QUEUE && follower.state !== 'degraded') {
        follower.state = 'degraded';
        follower.lastError = 'Follower is catching up; mirroring remains active.';
        this.onLog({
          level: 'warn',
          text: `${follower.name}: replay queue exceeded ${MAX_QUEUE}; retaining events and catching up.`,
        });
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
      while (pair.queue.length && this.running && this.mirroring) {
        const ev = pair.queue.shift();
        pair.queueDepth = pair.queue.length;
        if (ev.__mirrorEpoch !== this._mirrorEpoch) continue;
        const resolvedPair = await this._followerPair(leaderPage, followerId);
        if (!resolvedPair || !resolvedPair.page) break;
        if (!this.mirroring || ev.__mirrorEpoch !== this._mirrorEpoch) continue;
        try {
          if (ev.__url) {
            await this._ensureFollowerUrl(leaderPage, followerId, ev.__url);
            if (!this.mirroring || ev.__mirrorEpoch !== this._mirrorEpoch) continue;
            if (this._isStaleEvent(pair, ev, resolvedPair.page)) continue;
          }
          const target = await this._replayTarget(resolvedPair.page, ev);
          if (!target) continue;
          let result = await replayEvent(target, ev, this.settings);
          if (
            result && !result.ok && result.reason === 'not-found'
            && !this._isStaleEvent(pair, ev, resolvedPair.page)
          ) {
            await sleep(40);
            result = await replayEvent(target, ev, this.settings);
          }
          if (result && result.ok) {
            follower.replayFailures = 0;
            follower.lastLatencyMs = Math.max(0, Date.now() - Number(ev.ts || Date.now()));
            if (follower.state === 'degraded' && pair.queue.length < 25) {
              follower.state = 'ready';
              follower.lastError = null;
            }
          } else if (result && !result.ok) {
            follower.replayFailures = (follower.replayFailures || 0) + 1;
            follower.lastError = `replay ${ev.kind}: ${result.reason || 'not-applied'}`;
            if (follower.replayFailures === 1 || follower.replayFailures % 10 === 0) {
              this.onLog({ level: 'warn', text: `${follower.name}: ${follower.lastError}` });
            }
          }
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
      this._scheduleStatus();
      if (pair.queue.length && this.running && this.mirroring) {
        queueMicrotask(() => this._drainPair(leaderPage, followerId));
      }
    }
  }

  _syncNav(leaderPage, url) {
    if (!this.running || !this.mirroring || !url || !/^https?:/.test(url)) return Promise.resolve();
    const state = this.leaderPages.get(leaderPage);
    if (state && state.suppressNavUntil && Date.now() < state.suppressNavUntil) return Promise.resolve();
    const syncs = [];
    for (const follower of this.followers.values()) {
      if (isFollowerOperational(follower)) syncs.push(this._ensureFollowerUrl(leaderPage, follower.id, url));
    }
    return Promise.allSettled(syncs);
  }

  _ensureFollowerUrl(leaderPage, followerId, url) {
    if (!url || !/^https?:/.test(url)) return Promise.resolve();
    const state = this.leaderPages.get(leaderPage);
    const pair = state && this._ensurePair(state, followerId);
    if (!pair) return Promise.resolve();
    const currentPairPage = pair.page
      && !(typeof pair.page.isClosed === 'function' && pair.page.isClosed())
      ? pair.page
      : pair.preassigned;
    if (
      sameUrl(pair.desiredUrl, url)
      && currentPairPage
      && sameUrl(safeUrl(currentPairPage), url)
      && Date.now() - pair.lastNavAt < NAV_RELOAD_COOLDOWN_MS
    ) {
      return pair.navChain;
    }
    pair.desiredUrl = url;
    pair.navChain = pair.navChain.then(async () => {
      const resolvedPair = await this._followerPair(leaderPage, followerId);
      if (!resolvedPair || !resolvedPair.page || !sameUrl(pair.desiredUrl, url)) return;
      const targetPage = resolvedPair.page;
      const generation = pair.generation || 0;
      const currentUrl = safeUrl(targetPage);
      if (sameUrl(currentUrl, url)) return;
      const correctionKey = `${currentUrl || ''} -> ${url}`;
      if (currentUrl && pair.lastCorrectionKey !== correctionKey) {
        pair.lastCorrectionKey = correctionKey;
        const follower = this.followers.get(followerId);
        const level = isFollowerHelperTopLevelUrl(currentUrl) ? 'warn' : 'info';
        this.onLog({
          level,
          text: `${follower ? follower.name : followerId}: correcting follower tab ${shortUrl(currentUrl)} → ${shortUrl(url)}`,
        });
      }
      try {
        pair.lastNavAt = Date.now();
        await targetPage.goto(url, { timeout: 9000, waitUntil: 'commit' });
        if (pair.page !== targetPage || (pair.generation || 0) !== generation) return;
        // A heavy page (notably Chrome Web Store) may take much longer to fire
        // DOMContentLoaded than it takes to commit the correct URL. Show the
        // committed canonical tab immediately, but keep the readiness wait in
        // this navigation chain so queued replay events cannot race the DOM.
        await this._activateFollowerPageIfCurrentLeader(leaderPage, targetPage);
        if (pair.page !== targetPage || (pair.generation || 0) !== generation) return;
        await targetPage.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => {});
        if (pair.page !== targetPage || (pair.generation || 0) !== generation) return;
        const follower = this.followers.get(followerId);
        if (follower) follower.lastError = null;
        this.onLog({ level: 'info', text: `${follower ? follower.name : followerId} → ${shortUrl(url)}` });
      } catch (error) {
        if (pair.page !== targetPage || (pair.generation || 0) !== generation) return;
        const follower = this.followers.get(followerId);
        const failedUrl = safeUrl(targetPage);
        if (!sameUrl(failedUrl, url)) {
          if (follower) follower.lastError = `navigation: ${shortErr(error)}`;
          this.onLog({
            level: 'warn',
            text: `${follower ? follower.name : followerId}: navigation correction failed ${shortUrl(failedUrl)} -> ${shortUrl(url)} (${shortErr(error)})`,
          });
        }
        if (follower && isFollowerHelperTopLevelUrl(failedUrl)) {
          this._recoverAssignedFollowerHelper(follower, targetPage).catch(() => {});
        }
      }
    });
    return pair.navChain;
  }

  async _replayTarget(page, ev) {
    if (!ev || !page) return page;
    if (ev.__mainFrame === true) return page;
    if (ev.__mainFrame !== false && (!ev.__frameUrl || sameUrl(ev.__frameUrl, ev.__url))) return page;
    if (!ev.__frameUrl || !/^https?:/.test(ev.__frameUrl)) return null;
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      const childFrames = page.frames().filter((frame) =>
        typeof page.mainFrame !== 'function' || frame !== page.mainFrame()
      );
      for (const frame of childFrames) {
        if (sameUrl(safeFrameUrl(frame), ev.__frameUrl)) return frame;
      }
      for (const frame of childFrames) {
        if (sameFrameRoute(safeFrameUrl(frame), ev.__frameUrl)) return frame;
      }
      await sleep(75);
    }
    // A child-frame event must never fall back to the top-level page. Doing so
    // can click an unrelated main-page element and navigate the whole follower
    // to an iframe helper/proxy URL.
    return null;
  }

  _isStaleEvent(pair, ev, followerPage) {
    if (!ev || !ev.__url || ev.kind === 'scroll' || !/^https?:/.test(ev.__url)) return false;
    if (pair && pair.desiredUrl && !sameUrl(pair.desiredUrl, ev.__url)) return true;
    return followerPage && !sameUrl(safeUrl(followerPage), ev.__url);
  }

  _onFollowerContextClosed(followerId, closedContext = null) {
    const follower = this.followers.get(followerId);
    if (!follower || !this.running) return;
    if (closedContext && follower.context !== closedContext) return;
    follower.context = null;
    follower.state = 'recovering';
    follower.lastError = 'Follower browser closed.';
    this.onLog({ level: 'warn', text: `${follower.name} closed unexpectedly — automatic recovery started.` });
    this._scheduleFollowerRecovery(followerId, 'Follower browser closed');
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

function liveContextPages(context) {
  if (!context || typeof context.pages !== 'function') return [];
  try {
    return context.pages().filter((page) =>
      page && !(typeof page.isClosed === 'function' && page.isClosed())
    );
  } catch (_) {
    return [];
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
function sameFrameRoute(a, b) {
  if (!a || !b) return false;
  try {
    const A = new URL(a);
    const B = new URL(b);
    return A.origin === B.origin && A.pathname === B.pathname;
  } catch (_) {
    return false;
  }
}
function shortErr(error) {
  return String((error && error.message) || error).split('\n')[0].slice(0, 140);
}
function isFollowerHelperTopLevelUrl(url) {
  if (!url || !/^https?:/i.test(String(url))) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    return pathname === '/static/proxy.html'
      && (
        host === 'feedback-pa.clients6.google.com'
        || host.endsWith('.clients6.google.com')
        || host === 'clients6.google.com'
      );
  } catch (_) {
    return false;
  }
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

function isFollowerOperational(follower) {
  return !!(follower && (follower.state === 'ready' || follower.state === 'degraded'));
}

function coalesceQueuedEvent(queue, event) {
  if (!Array.isArray(queue) || !queue.length || !event) return false;
  const last = queue[queue.length - 1];
  if (event.kind === 'scroll' && last.kind === 'scroll' && last.__frameUrl === event.__frameUrl) {
    queue[queue.length - 1] = { ...event };
    return true;
  }
  const textKind = event.kind === 'text-op' || event.kind === 'input';
  const lastTextKind = last.kind === 'text-op' || last.kind === 'input';
  const eventKey = event.selectors && event.selectors[0];
  const lastKey = last.selectors && last.selectors[0];
  if (textKind && lastTextKind && eventKey && eventKey === lastKey && last.__frameUrl === event.__frameUrl) {
    queue[queue.length - 1] = {
      ...event,
      valueBefore: last.valueBefore != null ? last.valueBefore : event.valueBefore,
      selectionBefore: last.selectionBefore || event.selectionBefore,
    };
    return true;
  }
  return false;
}

module.exports = {
  MirrorEngine,
  describeEvent,
  minimizedPlan,
  tiledPlan,
  isFollowerHelperTopLevelUrl,
  startPage,
  coalesceQueuedEvent,
};
