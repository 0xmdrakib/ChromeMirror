'use strict';

/**
 * Closing Chrome Mirror is not the same operation as releasing its device.
 * A normal shutdown only stops network work; the encrypted activation token
 * stays on this computer and remains valid for the next launch.
 */
function stopLicenseForShutdown(license) {
  if (!license) return;
  if (typeof license.stopHeartbeat === 'function') license.stopHeartbeat();
}

module.exports = { stopLicenseForShutdown };
