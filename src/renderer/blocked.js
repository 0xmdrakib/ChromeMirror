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
  DEVICE_MISMATCH: {
    title: 'Device Not Authorized',
    message: 'This license is bound to a different device. Ask the admin to unbind it first.',
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
};

function applyReason(reason) {
  const r = REASONS[reason] || REASONS.UNVERIFIED;
  document.getElementById('title').textContent = r.title;
  document.getElementById('message').textContent = r.message;
}

// Ask the main process for the current reason (best effort).
window.api && window.api.checkLicense && window.api.checkLicense().then((s) => {
  // The state alone tells us we're blocked; reason may be on a push event.
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
