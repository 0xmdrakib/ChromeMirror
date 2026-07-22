'use strict';

function licensePageForState(state) {
  if (state === 'active') return 'index.html';
  if (state === 'needs_activation') return 'activate.html';
  return 'blocked.html';
}

function shouldNavigateAfterRetry(state) {
  return state === 'active' || state === 'needs_activation';
}

module.exports = { licensePageForState, shouldNavigateAfterRetry };
