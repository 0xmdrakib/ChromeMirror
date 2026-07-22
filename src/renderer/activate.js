'use strict';

const form = document.getElementById('activateForm');
const keyInput = document.getElementById('keyInput');
const btn = document.getElementById('activateBtn');
const errorBox = document.getElementById('errorBox');
const toast = document.getElementById('toast');
const {
  formatLicenseKey,
  formatLicenseKeyEdit,
  formatLicenseKeyPaste,
  isCompleteLicenseKey,
} = window.ChromeMirrorLicenseKey;

let composing = false;
let submitting = false;

function applyFormattedValue(raw, caret) {
  const next = formatLicenseKeyEdit(raw, caret);
  keyInput.value = next.value;
  keyInput.setSelectionRange(next.caret, next.caret);
  errorBox.hidden = true;
}

keyInput.addEventListener('input', () => {
  if (!composing) applyFormattedValue(keyInput.value, keyInput.selectionStart);
});
keyInput.addEventListener('compositionstart', () => {
  composing = true;
});
keyInput.addEventListener('compositionend', () => {
  composing = false;
  applyFormattedValue(keyInput.value, keyInput.selectionStart);
});
keyInput.addEventListener('paste', (event) => {
  const pasted = event.clipboardData && event.clipboardData.getData('text');
  if (!pasted) return;

  event.preventDefault();
  const next = formatLicenseKeyPaste(
    keyInput.value,
    keyInput.selectionStart,
    keyInput.selectionEnd,
    pasted
  );
  keyInput.value = next.value;
  keyInput.setSelectionRange(next.caret, next.caret);
  errorBox.hidden = true;
});

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function showToast(message) {
  toast.textContent = message;
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

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting) return;

  const key = formatLicenseKey(keyInput.value);
  keyInput.value = key;
  if (!isCompleteLicenseKey(key)) {
    showError('Enter the complete license key from your dashboard.');
    keyInput.focus();
    return;
  }

  submitting = true;
  btn.disabled = true;
  keyInput.readOnly = true;
  btn.textContent = 'Activating...';
  errorBox.hidden = true;
  let activated = false;

  try {
    const result = await window.api.activateLicense(key);
    if (result.ok) {
      activated = true;
      btn.textContent = 'Activated';
      showToast('Activated. Opening Chrome Mirror...');
      return;
    }

    const code = result.code;
    if (code === 'EMPTY') {
      showError('Please enter your license key.');
    } else if (
      code &&
      ['ABORT_ERR', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(code)
    ) {
      showError(FRIENDLY_ERRORS.NETWORK);
    } else {
      showError(FRIENDLY_ERRORS[code] || result.error || 'Activation failed. Please try again.');
    }
  } catch (error) {
    showError(error.message || 'Activation failed. Please try again.');
  } finally {
    if (!activated) {
      submitting = false;
      keyInput.readOnly = false;
      btn.disabled = false;
      btn.textContent = 'Activate';
      keyInput.focus();
    }
  }
});

keyInput.focus();
