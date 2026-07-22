'use strict';

const REASONS = {
  SUSPENDED: {
    title: 'License Suspended',
    message: 'This license has been suspended by the administrator. Please contact them to re-enable access.',
  },
  CANCELLED: {
    title: 'License Cancelled',
    message: 'This license has been permanently cancelled and can no longer be used.',
  },
  EXPIRED: {
    title: 'License Expired',
    message: 'This license has expired. Please contact the administrator to renew it.',
  },
  DEVICE_IN_USE: {
    title: 'License In Use',
    message: 'This license is active on another computer. Release that computer from the web portal first.',
  },
  SESSION_REPLACED: {
    title: 'Session Replaced',
    message: 'Another computer activated this license. Return to the portal if you need to release it.',
  },
  UNVERIFIED: {
    title: 'Could Not Verify License',
    message: 'The license server could not be reached for too long. Please connect to the internet and retry.',
  },
  BAD_TOKEN: {
    title: 'Session Invalid',
    message: 'Your activation is no longer valid. Please contact the administrator.',
  },
  NOT_FOUND: {
    title: 'License Not Found',
    message: 'This license no longer exists on the server.',
  },
  INVALID_KEY: {
    title: 'License Not Found',
    message: 'This license is no longer available on the hosted service.',
  },
};

const retryBtn = document.getElementById('retryBtn');
const retryStatus = document.getElementById('retryStatus');
let retrying = false;

function applyReason(reason) {
  const value = REASONS[reason] || REASONS.UNVERIFIED;
  document.getElementById('title').textContent = value.title;
  document.getElementById('message').textContent = value.message;
}

function setRetryStatus(message, state) {
  retryStatus.textContent = message || '';
  if (state) retryStatus.dataset.state = state;
  else delete retryStatus.dataset.state;
}

function isConnectivityReason(reason) {
  return [
    'UNVERIFIED',
    'NETWORK',
    'ABORT_ERR',
    'ENOTFOUND',
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
  ].includes(reason);
}

if (window.api && window.api.checkLicense) {
  window.api.checkLicense().then((status) => {
    if (status && status.reason) applyReason(status.reason);
  }).catch((error) => {
    console.error('[license] could not read the current license state:', error);
  });
}

if (window.api && window.api.onLicenseBlocked) {
  window.api.onLicenseBlocked((data) => {
    if (data && data.reason) applyReason(data.reason);
  });
}

retryBtn.addEventListener('click', async () => {
  if (retrying) return;
  retrying = true;
  retryBtn.disabled = true;
  retryBtn.textContent = 'Checking...';
  setRetryStatus('Contacting the license server...', 'checking');

  try {
    if (!window.api || !window.api.retryLicense) {
      throw new Error('License verification is unavailable. Please restart Chrome Mirror.');
    }

    const result = await window.api.retryLicense();
    if (!result || !result.state) {
      throw new Error('The license server returned an invalid response. Please try again.');
    }

    if (result.state === 'active') {
      setRetryStatus('License verified. Opening Chrome Mirror...', 'success');
      return;
    }

    if (result.state === 'needs_activation') {
      setRetryStatus('No active license was found. Opening activation...', 'success');
      return;
    }

    if (result.reason) applyReason(result.reason);
    setRetryStatus(
      isConnectivityReason(result.reason)
        ? 'Still unable to reach the license server. Check your connection and retry.'
        : 'This license is still locked. Resolve the issue above, then retry.',
      'error'
    );
  } catch (error) {
    console.error('[license] retry failed:', error);
    setRetryStatus(
      error && error.message
        ? error.message
        : 'Could not verify the license. Check your connection and try again.',
      'error'
    );
  } finally {
    // Successful states are about to navigate. Keep the button disabled during
    // that brief transition so a second request cannot race the first.
    if (retryStatus.dataset.state !== 'success') {
      retrying = false;
      retryBtn.disabled = false;
      retryBtn.textContent = 'Retry';
    }
  }
});
