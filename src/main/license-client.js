'use strict';

const { safeStorage, app } = require('electron');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { getDeviceId, getMachineInfo } = require('./device-id');
const {
  DEFAULT_LICENSE_API_URL,
  selectLicenseApiUrl,
} = require('./license-endpoint');

const STATE = {
  ACTIVE: 'active',
  NEEDS_ACTIVATION: 'needs_activation',
  BLOCKED: 'blocked',
};

const OFFLINE_GRACE_MS = (!app || !app.isPackaged) && process.env.CM_LICENSE_OFFLINE_GRACE_MS
  ? Math.max(0, Number(process.env.CM_LICENSE_OFFLINE_GRACE_MS) || 0)
  : 7 * 24 * 60 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;

function runtimeApiBase() {
  let configuredUrl = '';
  try {
    const configPath = path.join(__dirname, 'runtime-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    configuredUrl = config.licenseApiUrl || '';
  } catch (_) {}
  return selectLicenseApiUrl({
    isPackaged: !!(app && app.isPackaged),
    environmentUrl: process.env.LICENSE_API_URL,
    configuredUrl,
  });
}

const API_BASE_URL = runtimeApiBase();
const APP_VERSION = app ? app.getVersion() : '2.0.0';

class LicenseClient extends EventEmitter {
  constructor() {
    super();
    this._state = STATE.NEEDS_ACTIVATION;
    this._license = null;
    this._token = null;
    this._lastVerifiedAt = 0;
    this._heartbeatTimer = null;
    this._releaseSent = false;
    this._reason = null;
    this._deviceId = null;
  }

  get _storePath() {
    return path.join(app.getPath('userData'), 'license.bin');
  }

  get _storeBackupPath() {
    return `${this._storePath}.bak`;
  }

  get _deviceIdPath() {
    return path.join(app.getPath('userData'), 'device-id');
  }

  _readStored() {
    const primary = this._readStoredFile(this._storePath);
    if (primary) return primary;
    const backup = this._readStoredFile(this._storeBackupPath);
    if (backup) {
      try { fs.copyFileSync(this._storeBackupPath, this._storePath); } catch (_) {}
      return backup;
    }
    return null;
  }

  _readStoredFile(filePath) {
    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
      const data = safeStorage.decryptString(fs.readFileSync(filePath));
      const value = JSON.parse(data);
      return value && value.token ? value : null;
    } catch (_) {
      return null;
    }
  }

  _writeStored(token, license, lastVerifiedAt) {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
      const data = JSON.stringify({
        token,
        license,
        deviceId: this._deviceId,
        lastVerifiedAt,
        savedAt: Date.now(),
      });
      const encrypted = safeStorage.encryptString(data);
      const tempPath = `${this._storePath}.tmp`;
      fs.mkdirSync(path.dirname(this._storePath), { recursive: true });
      fs.writeFileSync(tempPath, encrypted);
      if (fs.existsSync(this._storePath)) {
        try { fs.copyFileSync(this._storePath, this._storeBackupPath); } catch (_) {}
      }
      try { fs.renameSync(tempPath, this._storePath); } catch (_) {
        try { fs.unlinkSync(this._storePath); } catch (_) {}
        fs.renameSync(tempPath, this._storePath);
      }
      return true;
    } catch (error) {
      try { fs.unlinkSync(`${this._storePath}.tmp`); } catch (_) {}
      console.error('[license] could not persist activation:', error.message);
      return false;
    }
  }

  _clearStored() {
    try { fs.unlinkSync(this._storePath); } catch (_) {}
    try { fs.unlinkSync(this._storeBackupPath); } catch (_) {}
  }

  async _resolveDeviceId(stored) {
    if (this._deviceId) return this._deviceId;
    const preferred = stored && (stored.deviceId || deviceIdFromToken(stored.token));
    this._deviceId = await getDeviceId(this._deviceIdPath, preferred);
    return this._deviceId;
  }

  async _call(endpoint, body, method = 'POST') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${API_BASE_URL}/${endpoint}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify(body || {}),
        signal: controller.signal,
      });
      let data = {};
      try { data = await response.json(); } catch (_) {}
      if (!response.ok) {
        const error = new Error(data.error || `Request failed (${response.status})`);
        error.code = data.code || `HTTP_${response.status}`;
        error.status = response.status;
        throw error;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  _isTransient(error) {
    if (!error) return false;
    const code = error.code || (error.cause && error.cause.code);
    return error.name === 'AbortError'
      || error.name === 'TypeError'
      || ['ABORT_ERR', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'NETWORK'].includes(code);
  }

  getState() {
    return this._state;
  }

  getLicense() {
    return this._license;
  }

  getReason() {
    return this._reason;
  }

  async checkAtBoot() {
    const stored = this._readStored();
    if (!stored || !stored.token) {
      this._setState(STATE.NEEDS_ACTIVATION);
      return { state: STATE.NEEDS_ACTIVATION };
    }

    this._token = stored.token;
    this._license = stored.license || null;
    this._lastVerifiedAt = stored.lastVerifiedAt || 0;
    await this._resolveDeviceId(stored);
    try {
      const result = await this._call('verify', { token: this._token, app_version: APP_VERSION });
      if (!result.valid) throw Object.assign(new Error('License is not valid'), { code: result.code });
      this._accept(result);
      this._setState(STATE.ACTIVE);
      return { state: STATE.ACTIVE, license: this._license };
    } catch (error) {
      let failure = error;
      if (error.code === 'BAD_TOKEN') {
        try {
          const resumed = await this._resumeStoredSession();
          this._accept(resumed);
          this._setState(STATE.ACTIVE);
          return { state: STATE.ACTIVE, license: this._license, resumed: true };
        } catch (resumeError) {
          // Older servers do not have /resume yet. Preserve the locally
          // verified activation during rollout instead of demanding the key.
          failure = isMissingResumeEndpoint(resumeError) ? error : resumeError;
        }
      }
      if (this._canUseCachedActivation(failure)) {
        this._setState(STATE.ACTIVE);
        return { state: STATE.ACTIVE, license: this._license, offline: true };
      }
      // Never erase a recoverable device binding merely because verification
      // failed. Retry can resume it after connectivity/admin state is fixed.
      const reason = failure.code || (isHardFailure(error.code) ? error.code : 'UNVERIFIED');
      this._setState(STATE.BLOCKED, reason);
      return { state: STATE.BLOCKED, reason };
    }
  }

  _canUseCachedActivation(error) {
    const age = Date.now() - this._lastVerifiedAt;
    return age < OFFLINE_GRACE_MS
      && (this._isTransient(error) || (error && error.code === 'BAD_TOKEN'));
  }

  async _resumeStoredSession() {
    if (!this._token) throw Object.assign(new Error('No stored activation session.'), { code: 'BAD_TOKEN' });
    return this._call('resume', {
      token: this._token,
      device_id: await this._resolveDeviceId(),
      machine_info: await getMachineInfo(),
      app_version: APP_VERSION,
    });
  }

  async activate(licenseKey) {
    const key = String(licenseKey || '').trim();
    if (!key) return { ok: false, error: 'Enter a license key.', code: 'EMPTY' };
    try {
      const result = await this._call('activate', {
        license_key: key,
        device_id: await this._resolveDeviceId(),
        machine_info: await getMachineInfo(),
        app_version: APP_VERSION,
      });
      this._token = result.token;
      this._license = result.license;
      this._lastVerifiedAt = Date.now();
      this._releaseSent = false;
      if (!this._writeStored(this._token, this._license, this._lastVerifiedAt)) {
        // Do not report a successful activation that will disappear on the
        // next boot. Release only this just-created, unusable session so the
        // same key is not stranded on the server.
        try { await this._call('release', { token: this._token }); } catch (_) {}
        this._token = null;
        this._license = null;
        this._lastVerifiedAt = 0;
        this._setState(STATE.NEEDS_ACTIVATION, 'STORAGE');
        return {
          ok: false,
          error: 'Chrome Mirror could not save activation securely on this computer.',
          code: 'STORAGE',
        };
      }
      this._setState(STATE.ACTIVE);
      return { ok: true, license: this._license };
    } catch (error) {
      const code = error.code
        || (error.cause && error.cause.code)
        || (this._isTransient(error) ? 'NETWORK' : 'ACTIVATION_FAILED');
      return { ok: false, error: error.message, code };
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this._releaseSent = false;
    const tick = async () => {
      if (this._state !== STATE.ACTIVE || !this._token) return;
      try {
        const result = await this._call('heartbeat', {
          token: this._token,
          app_version: APP_VERSION,
        });
        if (result.valid === false) throw Object.assign(new Error(result.error || 'License invalid'), { code: result.code });
        this._accept(result);
      } catch (error) {
        let failure = error;
        if (error.code === 'BAD_TOKEN') {
          try {
            const resumed = await this._resumeStoredSession();
            this._accept(resumed);
            return;
          } catch (resumeError) {
            failure = isMissingResumeEndpoint(resumeError) ? error : resumeError;
          }
        }
        if (this._canUseCachedActivation(failure)) return;
        if (isHardFailure(failure.code) || failure.code === 'BAD_TOKEN') {
          this._setState(STATE.BLOCKED, failure.code);
        }
      }
    };
    tick();
    this._heartbeatTimer = setInterval(tick, HEARTBEAT_INTERVAL_MS);
    if (this._heartbeatTimer.unref) this._heartbeatTimer.unref();
  }

  stopHeartbeat() {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = null;
  }

  async release() {
    if (this._releaseSent || !this._token) return;
    this._releaseSent = true;
    this.stopHeartbeat();
    try { await this._call('release', { token: this._token }); } catch (_) {}
  }

  _accept(result) {
    this._token = result.token || this._token;
    this._license = result.license || this._license;
    this._lastVerifiedAt = Date.now();
    this._writeStored(this._token, this._license, this._lastVerifiedAt);
  }

  _setState(next, reason) {
    const previous = this._state;
    this._state = next;
    this._reason = reason || null;
    if (previous !== next) {
      this.emit('state', next, reason);
      if (next === STATE.BLOCKED) this.emit('blocked', reason);
    }
  }
}

function isHardFailure(code) {
  return [
    'SUSPENDED',
    'CANCELLED',
    'EXPIRED',
    'DEVICE_MISMATCH',
    'DEVICE_IN_USE',
    'SESSION_REPLACED',
    'INVALID_KEY',
    'NOT_FOUND',
    'BAD_TOKEN',
  ].includes(code);
}

function isMissingResumeEndpoint(error) {
  return !!(error && (
    error.code === 'NOT_FOUND'
    || error.code === 'HTTP_404'
    || error.status === 404
  ));
}

function deviceIdFromToken(token) {
  try {
    const payload = String(token || '').split('.')[1];
    if (!payload) return null;
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof value.did === 'string' && /^[0-9a-f]{32}$/i.test(value.did)
      ? value.did.toLowerCase()
      : null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  LicenseClient,
  STATE,
  API_BASE_URL,
  DEFAULT_LICENSE_API_URL,
  OFFLINE_GRACE_MS,
  deviceIdFromToken,
  isMissingResumeEndpoint,
};
