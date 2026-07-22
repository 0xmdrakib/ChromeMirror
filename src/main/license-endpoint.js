'use strict';

const DEFAULT_LICENSE_API_URL =
  'https://chromemirror.rakibhq.xyz/api/v1/license';

function selectLicenseApiUrl({
  isPackaged = false,
  environmentUrl = '',
  configuredUrl = '',
} = {}) {
  const environment = String(environmentUrl || '').trim();
  const configured = String(configuredUrl || '').trim();

  if (!isPackaged && environment) return environment.replace(/\/$/, '');
  if (configured) return configured.replace(/\/$/, '');
  return DEFAULT_LICENSE_API_URL;
}

module.exports = {
  DEFAULT_LICENSE_API_URL,
  selectLicenseApiUrl,
};
