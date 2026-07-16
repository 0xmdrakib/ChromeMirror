'use strict';
const form = document.getElementById('activateForm');
const keyInput = document.getElementById('keyInput');
const btn = document.getElementById('activateBtn');
const errorBox = document.getElementById('errorBox');
const toast = document.getElementById('toast');

// Auto-format: CMIR-XXXX-XXXX-XXXX-XXXX as the user types.
function formatKey(raw) {
  let s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  while (s.startsWith('CMIRCMIR')) {
    s = s.slice(4);
  }
  const body = s.startsWith('CMIR') ? s.slice(4) : s;
  if (body.length > 16) {
    const chunks = [];
    chunks.push(body.slice(0, 16));
    let i = 16;
    while (i < body.length) {
      chunks.push(body.slice(i, i + 4));
      i += 4;
    }
    return 'CMIR-' + chunks.join('-');
  } else {
    const chunks = [];
    let i = 0;
    while (i < body.length) {
      chunks.push(body.slice(i, i + 4));
      i += 4;
    }
    return chunks.length ? 'CMIR-' + chunks.join('-') : 'CMIR';
  }
}
keyInput.addEventListener('input', () => {
  const f = formatKey(keyInput.value);
  if (f !== keyInput.value) keyInput.value = f;
  errorBox.hidden = true;
});

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
}
function showToast(msg) {
  toast.textContent = msg;
  toast.hidden = false;
  setTimeout(() => { toast.hidden = true; }, 2200);
}

const FRIENDLY_ERRORS = {
  INVALID_KEY: 'That license key was not found. Please check and try again.',
  SUSPENDED: 'This license is suspended. Contact the administrator.',
  CANCELLED: 'This license has been cancelled and can no longer be used.',
  EXPIRED: 'This license has expired.',
  DEVICE_IN_USE: 'This license is active on another computer. Release it from the web portal first.',
  SESSION_REPLACED: 'This computer session was replaced by another activation.',
  NETWORK: 'Could not reach the license server. Check your internet connection and try again.',
};

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = keyInput.value.trim();
  if (!key || key.length < 10) { showError('Please enter your license key.'); return; }

  btn.disabled = true;
  btn.textContent = 'Activating…';
  errorBox.hidden = true;
  try {
    const r = await window.api.activateLicense(key);
    if (r.ok) {
      showToast('Activated! Loading…');
      // The main process swaps the window to the control panel.
      return;
    }
    const code = r.code;
    if (code === 'EMPTY') { showError('Please enter your license key.'); }
    else if (code && ['ABORT_ERR', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(code)) {
      showError(FRIENDLY_ERRORS.NETWORK);
    } else {
      showError(FRIENDLY_ERRORS[code] || r.error || 'Activation failed. Please try again.');
    }
  } catch (err) {
    showError(err.message || 'Activation failed. Please try again.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Activate';
  }
});

// Focus the input on load.
keyInput.focus();
