'use strict';

// Surface any uncaught errors so the main process can log them.
window.addEventListener('error', (e) => {
  window.__lastError = `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`;
  console.error('RENDERER-ERROR', window.__lastError);
});
window.addEventListener('unhandledrejection', (e) => {
  window.__lastError = 'promise: ' + ((e.reason && e.reason.message) || e.reason);
  console.error('RENDERER-REJECT', window.__lastError);
});

const $ = (id) => document.getElementById(id);

// Preview/dev fallback: when opened in a plain browser (no Electron preload),
// provide a mock API so the UI renders for design work. No effect in the app.
if (!window.api) {
  const sample = [
    { id: 'a', name: 'Main account', dir: '', createdAt: Date.now(), lastUsedAt: Date.now() - 3600e3 },
    { id: 'b', name: 'Mirror account', dir: '', createdAt: Date.now(), lastUsedAt: null },
  ];
  let roles = { leaderId: 'a', followerId: 'b' };
  let settings = { skipPassword: false, coordFallback: true, syncFullFieldValues: false };
  window.api = {
    listProfiles: async () => sample,
    createProfile: async () => {},
    renameProfile: async () => {},
    deleteProfile: async () => {},
    getRoles: async () => roles,
    setRoles: async (l, f) => { roles = { leaderId: l, followerId: f }; },
    getSettings: async () => settings,
    setSettings: async (p) => { settings = Object.assign(settings, p); },
    getStatus: async () => ({ running: false, mirroring: false, eventCount: 0 }),
    startSession: async () => {},
    stopSession: async () => {},
    setMirror: async () => {},
    onStatus: () => {},
    onLog: () => {},
  };
}

const state = {
  running: false,
  mirroring: false,
  profiles: [],
  roles: { leaderId: null, followerId: null },
  settings: {},
};

/* ----------------------------- bootstrap ----------------------------- */
async function init() {
  await refresh();
  wireEvents();
  api.onStatus(applyStatus);
  api.onLog(appendLog);
  renderLog([]);
}

async function refresh() {
  state.profiles = await api.listProfiles();
  state.roles = await api.getRoles();
  state.settings = await api.getSettings();
  renderProfiles();
  renderSelectors();
  renderSettings();
}

/* ----------------------------- rendering ----------------------------- */
function renderSelectors() {
  const opts =
    '<option value="">— select —</option>' +
    state.profiles.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  const leader = $('leaderSel');
  const follower = $('followerSel');
  leader.innerHTML = opts;
  follower.innerHTML = opts;
  leader.value = state.roles.leaderId || '';
  follower.value = state.roles.followerId || '';
  leader.disabled = state.running;
  follower.disabled = state.running;
  $('swapBtn').disabled = state.running;
  updateAvatars();
}

function updateAvatars() {
  const lp = state.profiles.find((p) => p.id === $('leaderSel').value);
  const fp = state.profiles.find((p) => p.id === $('followerSel').value);
  $('leaderAvatar').textContent = lp ? initials(lp.name) : '—';
  $('followerAvatar').textContent = fp ? initials(fp.name) : '—';
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/);
  if (!parts[0]) return '—';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

function renderProfiles() {
  const ul = $('profileList');
  if (!state.profiles.length) {
    ul.innerHTML = '<li class="empty">No profiles yet — create one to get started.</li>';
    return;
  }
  ul.innerHTML = state.profiles
    .map(
      (p) => `
      <li data-id="${p.id}">
        <span class="pavatar">${esc(initials(p.name))}</span>
        <span class="pname">${esc(p.name)}</span>
        <span class="pmeta">${p.lastUsedAt ? 'last used ' + timeAgo(p.lastUsedAt) : 'never used'}</span>
        <span class="prow-actions">
          <button class="btn tiny ghost" data-act="rename">Rename</button>
          <button class="btn tiny danger ghost" data-act="delete">Delete</button>
        </span>
      </li>`
    )
    .join('');
}

function renderSettings() {
  $('setSkipPwd').checked = !!state.settings.skipPassword;
  $('setCoord').checked = !!state.settings.coordFallback;
  $('setFullSync').checked = !!state.settings.syncFullFieldValues;
}

function applyStatus(s) {
  state.running = s.running;
  state.mirroring = s.mirroring;

  const pill = $('statusPill');
  const txt = $('statusText');
  if (!s.running) {
    pill.dataset.state = 'idle';
    txt.textContent = 'Idle';
  } else if (s.mirroring) {
    pill.dataset.state = 'mirroring';
    txt.textContent = 'Mirroring';
  } else {
    pill.dataset.state = 'running';
    txt.textContent = 'Paused';
  }

  const sw = $('mirrorSwitch');
  sw.disabled = !s.running;
  sw.classList.toggle('on', !!s.mirroring);

  const tl = $('toggleLabel');
  tl.textContent = s.mirroring ? 'On' : 'Off';
  tl.classList.toggle('on', !!s.mirroring);
  $('hero').classList.toggle('flowing', !!(s.running && s.mirroring));

  $('startBtn').disabled = s.running;
  $('stopBtn').disabled = !s.running;
  $('eventCount').textContent = `${s.eventCount || 0} events`;

  $('mirrorHint').textContent = !s.running
    ? 'Start a session to begin mirroring.'
    : s.mirroring
    ? 'Live — actions in the Leader are mirrored to the Follower.'
    : 'Paused — actions are not being mirrored.';

  renderSelectors();
}

/* ----------------------------- events ----------------------------- */
function wireEvents() {
  $('leaderSel').addEventListener('change', () => { updateAvatars(); saveRoles(); });
  $('followerSel').addEventListener('change', () => { updateAvatars(); saveRoles(); });

  $('swapBtn').addEventListener('click', () => {
    const l = $('leaderSel').value;
    $('leaderSel').value = $('followerSel').value;
    $('followerSel').value = l;
    saveRoles();
  });

  $('startBtn').addEventListener('click', async () => {
    try {
      $('startBtn').disabled = true;
      await api.startSession();
      toast('Session started');
      await refresh();
    } catch (e) {
      toast(cleanErr(e), true);
      $('startBtn').disabled = false;
    }
  });

  $('stopBtn').addEventListener('click', async () => {
    try {
      await api.stopSession();
      toast('Session stopped');
      await refresh();
    } catch (e) {
      toast(cleanErr(e), true);
    }
  });

  $('mirrorSwitch').addEventListener('click', async () => {
    if ($('mirrorSwitch').disabled) return;
    await api.setMirror(!state.mirroring);
  });

  $('addProfileBtn').addEventListener('click', async () => {
    const name = await askText('Name this profile', `Profile ${state.profiles.length + 1}`);
    if (name === null) return;
    await api.createProfile(name);
    await refresh();
  });

  $('profileList').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.closest('li').dataset.id;
    const profile = state.profiles.find((p) => p.id === id);
    if (btn.dataset.act === 'rename') {
      const name = await askText('Rename profile', profile ? profile.name : '');
      if (name) {
        await api.renameProfile(id, name);
        await refresh();
      }
    } else if (btn.dataset.act === 'delete') {
      if (state.running) return toast('Stop the session before deleting a profile.', true);
      const ok = confirm(
        `Delete “${profile ? profile.name : ''}”?\n\nThis erases its saved logins and data. This cannot be undone.`
      );
      if (ok) {
        await api.deleteProfile(id);
        await refresh();
      }
    }
  });

  $('setSkipPwd').addEventListener('change', (e) =>
    api.setSettings({ skipPassword: e.target.checked })
  );
  $('setCoord').addEventListener('change', (e) =>
    api.setSettings({ coordFallback: e.target.checked })
  );
  $('setFullSync').addEventListener('change', (e) =>
    api.setSettings({ syncFullFieldValues: e.target.checked })
  );

  $('clearLog').addEventListener('click', () => renderLog([]));
}

async function saveRoles() {
  await api.setRoles($('leaderSel').value || null, $('followerSel').value || null);
  state.roles = await api.getRoles();
}

/* ----------------------------- log ----------------------------- */
const MAX_LOG = 400;
let logRows = [];

function renderLog(rows) {
  logRows = rows;
  const el = $('log');
  if (!rows.length) {
    el.innerHTML = '<div class="empty-log">Mirrored actions will appear here…</div>';
    return;
  }
  el.innerHTML = rows
    .map(
      (r) =>
        `<div class="row"><span class="ts">${r.time}</span><span class="${r.level}">${esc(
          r.text
        )}</span></div>`
    )
    .join('');
  el.scrollTop = el.scrollHeight;
}

function appendLog(l) {
  const row = { time: clock(l.t), level: l.level || 'info', text: l.text };
  const next = logRows.concat([row]).slice(-MAX_LOG);
  renderLog(next);
}

/* ----------------------------- helpers ----------------------------- */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function clock(t) {
  const d = new Date(t || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function timeAgo(t) {
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function cleanErr(e) {
  const msg = String((e && e.message) || e);
  return msg.replace(/^Error:\s*/, '').replace(/^.*Error invoking remote method '[^']+':\s*Error:\s*/, '');
}

// Promise-based text prompt (Electron has no window.prompt).
function askText(title, defaultValue) {
  return new Promise((resolve) => {
    const backdrop = $('modalBackdrop');
    const input = $('modalInput');
    $('modalTitle').textContent = title;
    input.value = defaultValue || '';
    backdrop.hidden = false;
    input.focus();
    input.select();

    const done = (val) => {
      backdrop.hidden = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onOk = () => done(input.value.trim() || null);
    const onCancel = () => done(null);
    const onKey = (e) => {
      if (e.key === 'Enter') onOk();
      else if (e.key === 'Escape') onCancel();
    };

    const okBtn = $('modalOk');
    const cancelBtn = $('modalCancel');
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
  });
}

let toastTimer = null;
function toast(text, isError) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('error', !!isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

init();
