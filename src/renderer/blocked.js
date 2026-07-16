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

function applyReason(reason) {
  const r = REASONS[reason] || REASONS.UNVERIFIED;
  document.getElementById('title').textContent = r.title;
  document.getElementById('message').textContent = r.message;
}

// Ask the main process for the current reason (best effort).
window.api && window.api.checkLicense && window.api.checkLicense().then((s) => {
  if (s && s.reason) applyReason(s.reason);
}).catch(() => {});

window.api && window.api.onLicenseBlocked && window.api.onLicenseBlocked((d) => {
  if (d && d.reason) applyReason(d.reason);
});

document.getElementById('retryBtn').addEventListener('click', async function () {
  this.disabled = true;
  this.textContent = 'Checking…';
  try {
    if (window.api && window.api.retryLicense) {
      await window.api.retryLicense();
    } else {
      window.location.reload();
    }
  } catch (_) {}
  this.disabled = false;
  this.textContent = 'Retry';
});
