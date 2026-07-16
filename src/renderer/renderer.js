'use strict';

window.addEventListener('error', (event) => {
  window.__lastError = `${event.message} @ ${event.filename}:${event.lineno}:${event.colno}`;
  console.error('RENDERER-ERROR', window.__lastError);
});
window.addEventListener('unhandledrejection', (event) => {
  window.__lastError = 'promise: ' + ((event.reason && event.reason.message) || event.reason);
  console.error('RENDERER-REJECT', window.__lastError);
});

const $ = (id) => document.getElementById(id);
const MAX_PROFILES = 25;
const MAX_FOLLOWERS = 24;

if (!window.api) {
  const sample = Array.from({ length: 7 }, (_, index) => ({
    id: String.fromCharCode(97 + index),
    name: index === 0 ? 'Primary account' : `Store account ${index}`,
    dir: '',
    createdAt: Date.now() - index * 86400000,
    lastUsedAt: index < 3 ? Date.now() - index * 3600000 : null,
  }));
  let roles = { leaderId: 'a', followerIds: ['b', 'c', 'd'], windowLayout: 'minimized' };
  let settings = {
    skipPassword: false,
    coordFallback: true,
    syncFullFieldValues: false,
    windowLayout: 'minimized',
  };
  window.api = {
    listProfiles: async () => sample,
    createProfile: async () => {},
    renameProfile: async () => {},
    deleteProfile: async () => {},
    getRoles: async () => roles,
    setRoles: async (leaderId, followerIds, windowLayout) => {
      roles = { leaderId, followerIds, windowLayout };
    },
    getSettings: async () => settings,
    setSettings: async (patch) => { settings = Object.assign(settings, patch); },
    getStatus: async () => ({ running: false, mirroring: false, eventCount: 0, followers: [] }),
    startSession: async () => {},
    stopSession: async () => {},
    setMirror: async () => {},
    focusProfile: async () => {},
    retryFollower: async () => {},
    setWindowLayout: async (layout) => { settings.windowLayout = layout; },
    onStatus: () => {},
    onLog: () => {},
    licenseStatus: async () => ({ license: { label: 'Lifetime plan', plan: 'lifetime' } }),
  };
}

const bridge = window.api;
const state = {
  running: false,
  mirroring: false,
  profiles: [],
  roles: { leaderId: null, followerIds: [], windowLayout: 'minimized' },
  settings: {},
  followerStatuses: [],
};

const VIEW_COPY = {
  session: ['Session', 'Choose a leader and up to 24 followers.'],
  profiles: ['Profiles', 'Manage persistent Chrome identities.'],
  activity: ['Activity', 'Inspect recent mirroring and browser events.'],
  settings: ['Settings', 'Control how actions are replayed.'],
};

async function init() {
  wireNavigation();
  wireEvents();
  await refresh();
  applyStatus(await bridge.getStatus());
  bridge.onStatus(applyStatus);
  bridge.onLog(appendLog);
  renderLog([]);
  if (bridge.licenseStatus) {
    bridge.licenseStatus().then((result) => {
      const license = result && result.license;
      $('licenseLabel').textContent = license
        ? license.label || (license.plan === 'lifetime' ? 'Lifetime access' : 'Active access')
        : 'Active access';
    }).catch(() => {});
  }
}

async function refresh() {
  state.profiles = await bridge.listProfiles();
  state.roles = await bridge.getRoles();
  state.roles.followerIds = Array.isArray(state.roles.followerIds) ? state.roles.followerIds : [];
  state.settings = await bridge.getSettings();
  renderLeaderSelect();
  renderFollowerPicker();
  renderProfiles();
  renderSettings();
  renderSelectionSummary();
}

function wireNavigation() {
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.addEventListener('click', () => {
      const view = button.dataset.view;
      document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item === button));
      document.querySelectorAll('.view').forEach((section) => section.classList.toggle('active', section.id === `view-${view}`));
      $('viewTitle').textContent = VIEW_COPY[view][0];
      $('viewSubtitle').textContent = VIEW_COPY[view][1];
    });
  });
}

function renderLeaderSelect() {
  const select = $('leaderSel');
  select.innerHTML =
    '<option value="">Select a leader profile</option>' +
    state.profiles.map((profile) => `<option value="${profile.id}">${esc(profile.name)}</option>`).join('');
  select.value = state.roles.leaderId || '';
  select.disabled = state.running;
  const leader = profileById(select.value);
  $('leaderAvatar').textContent = leader ? initials(leader.name) : '—';
}

function renderFollowerPicker() {
  const leaderId = state.roles.leaderId;
  const selected = new Set(state.roles.followerIds);
  const candidates = state.profiles.filter((profile) => profile.id !== leaderId);
  const container = $('followerPicker');
  if (!candidates.length) {
    container.innerHTML = '<div class="empty-picker">Create another profile to add a follower.</div>';
    return;
  }
  container.innerHTML = candidates.map((profile) => {
    const checked = selected.has(profile.id);
    return `
      <label class="follower-option${checked ? ' selected' : ''}">
        <input type="checkbox" value="${profile.id}" ${checked ? 'checked' : ''} ${state.running ? 'disabled' : ''} />
        <span class="profile-avatar">${esc(initials(profile.name))}</span>
        <span class="option-copy"><strong>${esc(profile.name)}</strong><small>${profile.lastUsedAt ? `Used ${timeAgo(profile.lastUsedAt)}` : 'Not used yet'}</small></span>
        <span class="checkmark">✓</span>
      </label>`;
  }).join('');
  container.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
    checkbox.addEventListener('change', async () => {
      const values = Array.from(container.querySelectorAll('input:checked')).map((input) => input.value);
      if (values.length > MAX_FOLLOWERS) {
        checkbox.checked = false;
        toast(`A session supports up to ${MAX_FOLLOWERS} followers.`, true);
        return;
      }
      state.roles.followerIds = values;
      await saveRoles();
      renderFollowerPicker();
      renderSelectionSummary();
    });
  });
}

function renderSelectionSummary() {
  const count = state.roles.followerIds.length;
  $('selectedCount').textContent = count;
  $('capacityText').textContent = `${state.profiles.length} / ${MAX_PROFILES} profiles`;
  $('selectionMessage').textContent = count > 10
    ? 'Large sessions use substantial CPU and memory. Browsers launch in small batches.'
    : '';
}

function renderProfiles() {
  const container = $('profileList');
  if (!state.profiles.length) {
    container.innerHTML = '<div class="empty-table">No profiles yet. Create a leader and at least one follower.</div>';
    return;
  }
  container.innerHTML = `
    <div class="profile-table-head"><span>Profile</span><span>Role</span><span>Last used</span><span></span></div>
    ${state.profiles.map((profile) => {
      const role = profile.id === state.roles.leaderId
        ? 'Leader'
        : state.roles.followerIds.includes(profile.id) ? 'Follower' : 'Available';
      return `
        <div class="profile-row" data-id="${profile.id}">
          <span class="profile-identity"><span class="profile-avatar">${esc(initials(profile.name))}</span><span><strong>${esc(profile.name)}</strong><small>Persistent Chrome profile</small></span></span>
          <span><span class="role-badge ${role.toLowerCase()}">${role}</span></span>
          <span class="muted">${profile.lastUsedAt ? timeAgo(profile.lastUsedAt) : 'Never'}</span>
          <span class="row-actions">
            <button class="icon-btn" data-act="rename" title="Rename profile"><span data-lucide="pencil"></span></button>
            <button class="icon-btn danger" data-act="delete" title="Delete profile"><span data-lucide="trash-2"></span></button>
          </span>
        </div>`;
    }).join('')}`;
  if (window.renderLucideIcons) window.renderLucideIcons(container);
}

function renderSettings() {
  $('setSkipPwd').checked = !!state.settings.skipPassword;
  $('setCoord').checked = !!state.settings.coordFallback;
  $('setFullSync').checked = !!state.settings.syncFullFieldValues;
  $('layoutSelect').value = state.settings.windowLayout || state.roles.windowLayout || 'minimized';
}

function renderFollowerStatuses(statuses) {
  const container = $('followerStatusList');
  if (!state.running && !statuses.length) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon"><span data-lucide="monitor-up" data-lucide-size="18"></span></span>
        <strong>No session running</strong>
        <p>Selected followers will appear here with live health and queue status.</p>
      </div>`;
    return;
  }
  if (!statuses.length) {
    container.innerHTML = '<div class="empty-state"><strong>Preparing followers</strong><p>Chrome windows are starting.</p></div>';
    return;
  }
  container.innerHTML = statuses.map((follower) => {
    const stateLabel = follower.state === 'ready' ? 'Ready' : follower.state === 'launching' ? 'Launching' : follower.state;
    const canRetry = ['closed', 'error', 'degraded'].includes(follower.state);
    return `
      <div class="follower-status" data-id="${follower.id}">
        <span class="health-dot ${follower.state}"></span>
        <span class="status-copy">
          <strong>${esc(follower.name)}</strong>
          <small>${esc(follower.lastError || `${follower.tabs || 0} tab${follower.tabs === 1 ? '' : 's'} · queue ${follower.queueDepth || 0}`)}</small>
        </span>
        <span class="state-label ${follower.state}">${esc(stateLabel)}</span>
        <button class="icon-btn" data-act="focus" title="Focus browser"><span data-lucide="crosshair"></span></button>
        ${canRetry ? '<button class="icon-btn" data-act="retry" title="Retry follower"><span data-lucide="rotate-ccw"></span></button>' : ''}
      </div>`;
  }).join('');
  if (window.renderLucideIcons) window.renderLucideIcons(container);
}

function applyStatus(status) {
  status = status || {};
  state.running = !!status.running;
  state.mirroring = !!status.mirroring;
  state.followerStatuses = Array.isArray(status.followers) ? status.followers : [];

  const pill = $('statusPill');
  if (!state.running) {
    pill.dataset.state = 'idle';
    $('statusText').textContent = 'Idle';
  } else if (state.mirroring) {
    pill.dataset.state = 'mirroring';
    $('statusText').textContent = 'Broadcasting';
  } else {
    pill.dataset.state = 'paused';
    $('statusText').textContent = 'Paused';
  }

  $('mirrorSwitch').disabled = !state.running;
  $('mirrorSwitch').classList.toggle('on', state.mirroring);
  $('toggleLabel').textContent = state.mirroring ? 'Mirroring on' : 'Mirroring off';
  $('mirrorHint').textContent = !state.running
    ? 'Start a session to begin.'
    : state.mirroring ? 'Leader actions are broadcasting.' : 'Follower replay is paused.';
  $('startBtn').disabled = state.running;
  $('stopBtn').disabled = !state.running;
  $('tileNowBtn').disabled = !state.running;
  $('focusLeaderBtn').disabled = !state.running;
  $('eventCount').textContent = `${status.eventCount || 0} events`;

  const progress = status.launchProgress || { completed: 0, total: 0 };
  const showProgress = state.running && progress.total > 0 && progress.completed < progress.total;
  $('launchProgress').hidden = !showProgress;
  $('launchFraction').textContent = `${progress.completed} / ${progress.total}`;
  $('launchBar').style.width = progress.total ? `${Math.round((progress.completed / progress.total) * 100)}%` : '0%';

  renderLeaderSelect();
  renderFollowerPicker();
  renderFollowerStatuses(state.followerStatuses);
}

function wireEvents() {
  $('leaderSel').addEventListener('change', async () => {
    state.roles.leaderId = $('leaderSel').value || null;
    state.roles.followerIds = state.roles.followerIds.filter((id) => id !== state.roles.leaderId);
    await saveRoles();
    renderLeaderSelect();
    renderFollowerPicker();
    renderProfiles();
    renderSelectionSummary();
  });

  $('selectAllFollowers').addEventListener('click', async () => {
    if (state.running) return;
    const available = state.profiles.filter((profile) => profile.id !== state.roles.leaderId).slice(0, MAX_FOLLOWERS);
    const allSelected = available.length && available.every((profile) => state.roles.followerIds.includes(profile.id));
    state.roles.followerIds = allSelected ? [] : available.map((profile) => profile.id);
    await saveRoles();
    renderFollowerPicker();
    renderSelectionSummary();
  });

  $('layoutSelect').addEventListener('change', async (event) => {
    state.settings.windowLayout = event.target.value;
    state.roles.windowLayout = event.target.value;
    await bridge.setWindowLayout(event.target.value);
  });
  $('tileNowBtn').addEventListener('click', () => bridge.setWindowLayout('tiled'));
  $('focusLeaderBtn').addEventListener('click', () => bridge.focusProfile('leader'));

  $('startBtn').addEventListener('click', async () => {
    try {
      $('startBtn').disabled = true;
      await saveRoles();
      await bridge.startSession();
      toast('Session started.');
    } catch (error) {
      toast(cleanErr(error), true);
      $('startBtn').disabled = false;
    }
  });
  $('stopBtn').addEventListener('click', async () => {
    try {
      await bridge.stopSession();
      toast('Session stopped.');
      await refresh();
    } catch (error) {
      toast(cleanErr(error), true);
    }
  });
  $('mirrorSwitch').addEventListener('click', () => bridge.setMirror(!state.mirroring));

  $('followerStatusList').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button) return;
    const row = button.closest('[data-id]');
    if (!row) return;
    if (button.dataset.act === 'focus') await bridge.focusProfile(row.dataset.id);
    if (button.dataset.act === 'retry') await bridge.retryFollower(row.dataset.id);
  });

  $('addProfileBtn').addEventListener('click', async () => {
    if (state.profiles.length >= MAX_PROFILES) return toast(`Maximum ${MAX_PROFILES} profiles reached.`, true);
    const name = await askText('New Chrome profile', `Profile ${state.profiles.length + 1}`);
    if (!name) return;
    try {
      await bridge.createProfile(name);
      await refresh();
    } catch (error) {
      toast(cleanErr(error), true);
    }
  });

  $('profileList').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button) return;
    const row = button.closest('[data-id]');
    const profile = row && profileById(row.dataset.id);
    if (!profile) return;
    if (button.dataset.act === 'rename') {
      const name = await askText('Rename profile', profile.name);
      if (name) {
        await bridge.renameProfile(profile.id, name);
        await refresh();
      }
    } else if (button.dataset.act === 'delete') {
      if (state.running) return toast('Stop the session before deleting a profile.', true);
      if (confirm(`Delete "${profile.name}"?\n\nThis permanently erases its saved Chrome data.`)) {
        await bridge.deleteProfile(profile.id);
        await refresh();
      }
    }
  });

  $('setSkipPwd').addEventListener('change', (event) => bridge.setSettings({ skipPassword: event.target.checked }));
  $('setCoord').addEventListener('change', (event) => bridge.setSettings({ coordFallback: event.target.checked }));
  $('setFullSync').addEventListener('change', (event) => bridge.setSettings({ syncFullFieldValues: event.target.checked }));
  $('clearLog').addEventListener('click', () => renderLog([]));
}

async function saveRoles() {
  await bridge.setRoles(
    state.roles.leaderId,
    state.roles.followerIds,
    state.settings.windowLayout || state.roles.windowLayout || 'minimized'
  );
  state.roles = await bridge.getRoles();
}

const MAX_LOG = 500;
let logRows = [];

function renderLog(rows) {
  logRows = rows;
  const container = $('log');
  if (!rows.length) {
    container.innerHTML = '<div class="empty-log"><strong>No activity yet</strong><span>Mirrored actions and follower health events will appear here.</span></div>';
    return;
  }
  container.innerHTML = rows.map((row) => `
    <div class="log-row">
      <span class="log-time">${row.time}</span>
      <span class="log-level ${row.level}">${row.level}</span>
      <span class="log-text">${esc(row.text)}</span>
    </div>`).join('');
  container.scrollTop = container.scrollHeight;
}

function appendLog(entry) {
  const row = { time: clock(entry.t), level: entry.level || 'info', text: entry.text };
  renderLog(logRows.concat([row]).slice(-MAX_LOG));
}

function askText(title, defaultValue) {
  return new Promise((resolve) => {
    const backdrop = $('modalBackdrop');
    const input = $('modalInput');
    const okButton = $('modalOk');
    const cancelButton = $('modalCancel');
    $('modalTitle').textContent = title;
    input.value = defaultValue || '';
    backdrop.hidden = false;
    input.focus();
    input.select();

    const done = (value) => {
      backdrop.hidden = true;
      okButton.removeEventListener('click', onOk);
      cancelButton.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onOk = () => done(input.value.trim() || null);
    const onCancel = () => done(null);
    const onKey = (event) => {
      if (event.key === 'Enter') onOk();
      if (event.key === 'Escape') onCancel();
    };
    okButton.addEventListener('click', onOk);
    cancelButton.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
  });
}

function profileById(id) {
  return state.profiles.find((profile) => profile.id === id);
}
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return parts[0] ? (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase() : '—';
}
function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[char]));
}
function clock(value) {
  const date = new Date(value || Date.now());
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((item) => String(item).padStart(2, '0')).join(':');
}
function timeAgo(value) {
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
function cleanErr(error) {
  return String((error && error.message) || error)
    .replace(/^Error:\s*/, '')
    .replace(/^.*Error invoking remote method '[^']+':\s*Error:\s*/, '');
}

let toastTimer = null;
function toast(text, isError) {
  const element = $('toast');
  element.textContent = text;
  element.classList.toggle('error', !!isError);
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 2800);
}

init();
