// ============================================================================
// Chrome Mirror — Admin dashboard logic
// Uses Supabase JS v2 (loaded from CDN in index.html).
//
// SETUP: replace the placeholders below with your project URL + anon key.
// These are safe to ship — the anon key is public; all protection is via RLS
// (only the admin auth user can read/write) and the service-role key (used
// only inside Edge Functions, never shipped here).
// ============================================================================

const SUPABASE_URL = "https://dqaswznssafnymtftiif.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRxYXN3em5zc2FmbnltdGZ0aWlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxMjc2MDQsImV4cCI6MjA5NzcwMzYwNH0.EgbF8dRNq8nDTSK10q-xQ1pO2o1aOS5PPycjUN8yVok";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Auto-refresh interval (ms)
const REFRESH_MS = 15000;
let refreshTimer = null;

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
function toast(msg, type = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast ' + type;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2600);
}
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function timeAgo(iso) {
  if (!iso) return 'never';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function shortHash(h) {
  if (!h) return '—';
  return h.length > 12 ? h.slice(0, 8) + '…' + h.slice(-4) : h;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) showDashboard(); else showLogin();
}

function showLogin() {
  $('loginScreen').hidden = false;
  $('dashScreen').hidden = true;
}
function showDashboard() {
  $('loginScreen').hidden = true;
  $('dashScreen').hidden = false;
  const u = sb.auth.getUser();
  u.then(({ data }) => { $('adminEmail').textContent = data?.user?.email || ''; });
  loadLicenses();
  startAutoRefresh();
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginError').hidden = true;
  $('loginBtn').disabled = true;
  $('loginBtn').textContent = 'Signing in…';
  try {
    const { error } = await sb.auth.signInWithPassword({
      email: $('loginEmail').value.trim(),
      password: $('loginPass').value,
    });
    if (error) throw error;
    showDashboard();
  } catch (err) {
    $('loginError').textContent = err.message || 'Login failed';
    $('loginError').hidden = false;
  } finally {
    $('loginBtn').disabled = false;
    $('loginBtn').textContent = 'Sign in';
  }
});

$('logoutBtn').addEventListener('click', async () => {
  await sb.auth.signOut();
  stopAutoRefresh();
  showLogin();
});

// ---------------------------------------------------------------------------
// Load + render licenses
// ---------------------------------------------------------------------------
async function loadLicenses() {
  const body = $('licBody');
  body.innerHTML = '<tr><td colspan="8" class="muted ta-center">Loading…</td></tr>';
  try {
    const { data, error } = await sb.from('v_licenses_admin').select('*');
    if (error) throw error;
    renderTable(data || []);
    updateStats(data || []);
  } catch (err) {
    body.innerHTML = `<tr><td colspan="8" class="error-text ta-center">${escapeHtml(err.message)}</td></tr>`;
  }
}

function currentFilter(list) {
  const q = $('searchInput').value.trim().toLowerCase();
  const status = $('filterStatus').value;
  const onlyOnline = $('onlyOnline').checked;
  return list.filter((l) => {
    if (status && l.status !== status) return false;
    if (onlyOnline && !l.is_online) return false;
    if (q) {
      const hay = `${l.license_key || ''} ${l.label || ''} ${l.notes || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderTable(allRows) {
  const rows = currentFilter(allRows);
  const body = $('licBody');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="8" class="muted ta-center">No licenses match.</td></tr>';
    return;
  }
  body.innerHTML = rows.map((l) => rowHtml(l)).join('');
}

function rowHtml(l) {
  const badge = `<span class="badge ${l.status}"><span class="dot"></span>${l.status}</span>`;
  const online = l.is_online ? '<span class="online-dot on"></span>' : '<span class="online-dot"></span>';
  return `
    <tr data-id="${l.id}" data-key="${escapeHtml(l.license_key)}">
      <td class="key-cell">${escapeHtml(l.license_key)}</td>
      <td>${escapeHtml(l.label || '—')}</td>
      <td>${online}${badge}</td>
      <td class="key-cell" title="${escapeHtml(l.bound_device_id || '')}">${shortHash(l.bound_device_id)}</td>
      <td title="${fmtDate(l.last_heartbeat_at)}">${timeAgo(l.last_heartbeat_at)}</td>
      <td>${fmtDate(l.created_at)}</td>
      <td>${fmtDate(l.expires_at)}</td>
      <td>
        <div class="row-actions">${actionButtons(l)}</div>
      </td>
    </tr>`;
}

function actionButtons(l) {
  const copy = `<button class="btn small" data-act="copy">Copy</button>`;
  const del = `<button class="btn small danger" data-act="delete">Delete</button>`;
  return `${copy}${del}`;
}

function updateStats(allRows) {
  $('statTotal').textContent = allRows.length;
  $('statOnline').textContent = allRows.filter((r) => r.is_online).length;
  $('statActive').textContent = allRows.filter((r) => r.status === 'active').length;
  $('statSuspended').textContent = allRows.filter((r) => r.status === 'suspended').length;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Row actions (event delegation)
// ---------------------------------------------------------------------------
$('licBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const tr = btn.closest('tr');
  const id = tr.dataset.id;
  const act = btn.dataset.act;
  const key = tr.dataset.key;

  if (act === 'copy') {
    await navigator.clipboard.writeText(key);
    toast('License key copied', 'success');
    return;
  }

  if (act === 'delete') {
    if (!confirm('PERMANENTLY delete this license? The app on that device will lock immediately, and this key will be deleted forever.')) return;
    btn.disabled = true;
    try {
      const { error } = await sb.from('licenses').delete().eq('id', id);
      if (error) throw error;
      toast('License deleted', 'success');
      await loadLicenses();
    } catch (err) {
      toast(err.message || 'Deletion failed', 'error');
    } finally {
      btn.disabled = false;
    }
  }
});

// ---------------------------------------------------------------------------
// Generate license
// ---------------------------------------------------------------------------
$('generateBtn').addEventListener('click', () => {
  $('genLabel').value = '';
  $('genMax').value = '1';
  $('genExpires').value = '';
  $('genNotes').value = '';
  $('genModal').hidden = false;
});
$('genCancel').addEventListener('click', () => { $('genModal').hidden = true; });
$('genConfirm').addEventListener('click', async () => {
  const btn = $('genConfirm');
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    let expiresAt = null;
    if ($('genExpires').value) {
      expiresAt = new Date($('genExpires').value).toISOString();
    }
    const { data, error } = await sb.rpc('create_license', {
      p_label: $('genLabel').value.trim() || null,
      p_max_devices: parseInt($('genMax').value, 10) || 1,
      p_expires_at: expiresAt,
      p_notes: $('genNotes').value.trim() || null,
    });
    if (error) throw error;
    $('genModal').hidden = true;
    $('keyReveal').textContent = data.license_key;
    $('keyModal').hidden = false;
    await loadLicenses();
  } catch (err) {
    toast(err.message || 'Could not create license', 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Generate';
  }
});

$('copyKeyBtn').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('keyReveal').textContent);
  toast('Copied', 'success');
});
$('keyClose').addEventListener('click', () => { $('keyModal').hidden = true; });

// ---------------------------------------------------------------------------
// Search / filter / refresh
// ---------------------------------------------------------------------------
$('searchInput').addEventListener('input', () => renderTable(lastLoaded()));
$('filterStatus').addEventListener('change', () => renderTable(lastLoaded()));
$('onlyOnline').addEventListener('change', () => renderTable(lastLoaded()));
$('refreshBtn').addEventListener('click', loadLicenses);

let _last = [];
function lastLoaded() { return _last; }
const _origLoad = loadLicenses;
loadLicenses = async function () {
  try {
    const { data, error } = await sb.from('v_licenses_admin').select('*');
    if (error) throw error;
    _last = data || [];
    renderTable(_last);
    updateStats(_last);
  } catch (err) {
    $('licBody').innerHTML = `<tr><td colspan="8" class="error-text ta-center">${escapeHtml(err.message)}</td></tr>`;
  }
};

function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(loadLicenses, REFRESH_MS);
}
function stopAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------
boot();
sb.auth.onAuthStateChange((_e, session) => {
  if (session) { showDashboard(); } else { stopAutoRefresh(); showLogin(); }
});
