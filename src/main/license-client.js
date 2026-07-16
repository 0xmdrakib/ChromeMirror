'use strict';

const { safeStorage, app } = require('electron');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { getDeviceId, getMachineInfo } = require('./device-id');

const STATE = {
  ACTIVE: 'active',
  NEEDS_ACTIVATION: 'needs_activation',
  BLOCKED: 'blocked',
};

const OFFLINE_GRACE_MS = 10 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;

function runtimeApiBase() {
  if (process.env.LICENSE_API_URL) return process.env.LICENSE_API_URL;
  try {
    const configPath = path.join(__dirname, 'runtime-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.licenseApiUrl) return config.licenseApiUrl;
  } catch (_) {}
  return 'http://localhost:3000/api/v1/license';
}

const API_BASE_URL = runtimeApiBase().replace(/\/$/, '');
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
  }

  get _storePath() {
    return path.join(app.getPath('userData'), 'license.bin');
  }

  _readStored() {
    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
      const data = safeStorage.decryptString(fs.readFileSync(this._storePath));
      const value = JSON.parse(data);
      return value && value.token ? value : null;
    } catch (_) {
      return null;
    }
  }

  _writeStored(token, license, lastVerifiedAt) {
    try {
      if (!safeStorage.isEncryptionAvailable()) return;
      const data = JSON.stringify({ token, license, lastVerifiedAt, savedAt: Date.now() });
      fs.writeFileSync(this._storePath, safeStorage.encryptString(data));
    } catch (_) {}
  }

  _clearStored() {
    try { fs.unlinkSync(this._storePath); } catch (_) {}
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
    return error.name === 'AbortError'
      || ['ABORT_ERR', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'NETWORK'].includes(error.code);
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
    try {
      const result = await this._call('verify', { token: this._token, app_version: APP_VERSION });
      if (!result.valid) throw Object.assign(new Error('License is not valid'), { code: result.code });
      this._accept(result);
      this._setState(STATE.ACTIVE);
      return { state: STATE.ACTIVE, license: this._license };
    } catch (error) {
      if (isHardFailure(error.code)) {
        this._clearStored();
        this._setState(STATE.BLOCKED, error.code);
        return { state: STATE.BLOCKED, reason: error.code };
      }
      if (this._isTransient(error) && Date.now() - this._lastVerifiedAt < OFFLINE_GRACE_MS) {
        this._setState(STATE.ACTIVE);
        return { state: STATE.ACTIVE, license: this._license, offline: true };
      }
      this._setState(STATE.BLOCKED, error.code || 'UNVERIFIED');
      return { state: STATE.BLOCKED, reason: error.code || 'UNVERIFIED' };
    }
  }

  async activate(licenseKey) {
    const key = String(licenseKey || '').trim();
    if (!key) return { ok: false, error: 'Enter a license key.', code: 'EMPTY' };
    try {
      const result = await this._call('activate', {
        license_key: key,
        device_id: await getDeviceId(),
        machine_info: await getMachineInfo(),
        app_version: APP_VERSION,
      });
      this._token = result.token;
      this._license = result.license;
      this._lastVerifiedAt = Date.now();
      this._releaseSent = false;
      this._writeStored(this._token, this._license, this._lastVerifiedAt);
      this._setState(STATE.ACTIVE);
      return { ok: true, license: this._license };
    } catch (error) {
      return { ok: false, error: error.message, code: error.code || 'ACTIVATION_FAILED' };
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
        if (isHardFailure(error.code)) {
          this._clearStored();
          this._setState(STATE.BLOCKED, error.code);
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

module.exports = { LicenseClient, STATE, API_BASE_URL, OFFLINE_GRACE_MS };
