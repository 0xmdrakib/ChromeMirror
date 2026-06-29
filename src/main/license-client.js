'use strict';

// ============================================================================
// License client — the bridge between the desktop app and the Supabase backend.
//
// Responsibilities:
//   - Hold the Supabase URL + anon key (embedded at build time).
//   - Call the Edge Functions: activate / verify / heartbeat.
//   - Persist the activation token on disk using Electron's safeStorage
//     (Windows DPAPI), so it's bound to THIS OS user account.
//   - Enforce an offline grace window: if the server can't be reached, allow
//     the app to keep running for OFFLINE_GRACE_MS since the last successful
//     verification, then lock.
//   - Run a background heartbeat that locks the app the moment the license is
//     suspended/cancelled from the admin panel.
//
// Security note: this file is the prime candidate for bytenode compilation
// (see scripts/compile.js) so the secrets + flow aren't trivially readable.
// ============================================================================

const { safeStorage, app } = require('electron');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { getDeviceId, getMachineInfo } = require('./device-id');

// ---- Build-time-injected configuration -------------------------------------
// These placeholders are replaced by scripts/inject-env.js at build time.
// In dev they fall back to env vars so you can `npm start` without a build.
const SUPABASE_URL = (() => {
  const v = "https://dqaswznssafnymtftiif.supabase.co";
  return v.startsWith('__') && v.endsWith('__') ? (process.env.SUPABASE_URL || '') : v;
})();
const SUPABASE_ANON_KEY = (() => {
  const v = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRxYXN3em5zc2FmbnltdGZ0aWlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxMjc2MDQsImV4cCI6MjA5NzcwMzYwNH0.EgbF8dRNq8nDTSK10q-xQ1pO2o1aOS5PPycjUN8yVok";
  return v.startsWith('__') && v.endsWith('__') ? (process.env.SUPABASE_ANON_KEY || '') : v;
})();
const APP_VERSION = app ? app.getVersion() : '1.0.0';

// ---- Tunables --------------------------------------------------------------
const OFFLINE_GRACE_MS = 24 * 60 * 60 * 1000;   // 24 hours
const HEARTBEAT_INTERVAL_MS = 60 * 1000;        // 1 minute
const REQUEST_TIMEOUT_MS = 8000;

const STATE = { ACTIVE: 'active', NEEDS_ACTIVATION: 'needs_activation', BLOCKED: 'blocked' };

class LicenseClient extends EventEmitter {
  constructor() {
    super();
    this._state = STATE.NEEDS_ACTIVATION;
    this._license = null;        // { license_key, label, status, expires_at }
    this._token = null;          // current JWT string
    this._lastVerifiedAt = 0;    // ms epoch of last successful server verify
    this._heartbeatTimer = null;
  }

  // ------------------------------------------------------------------
  // Local encrypted storage
  // ------------------------------------------------------------------
  get _storePath() {
    return path.join(app.getPath('userData'), 'license.bin');
  }

  _readStored() {
    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
      const buf = fs.readFileSync(this._storePath);
      const json = safeStorage.decryptString(buf);
      const obj = JSON.parse(json);
      return obj && obj.token ? obj : null;
    } catch (_) {
      return null;
    }
  }

  _writeStored(token, license, lastVerifiedAt) {
    try {
      if (!safeStorage.isEncryptionAvailable()) return;
      const json = JSON.stringify({ token, license, lastVerifiedAt, savedAt: Date.now() });
      const buf = safeStorage.encryptString(json);
      fs.writeFileSync(this._storePath, buf);
    } catch (_) { /* ignore disk errors */ }
  }

  _clearStored() {
    try { fs.unlinkSync(this._storePath); } catch (_) {}
  }

  // ------------------------------------------------------------------
  // HTTP helper (POST JSON to an Edge Function)
  // ------------------------------------------------------------------
  async _call(fn, body) {
    if (!SUPABASE_URL) throw new Error('SUPABASE_URL not configured');
    const url = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/${fn}`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      let data;
      try { data = await res.json(); } catch (_) { data = {}; }
      if (!res.ok) {
        const err = new Error(data.error || `request failed (${res.status})`);
        err.code = data.code || 'HTTP_' + res.status;
        err.status = res.status;
        throw err;
      }
      return data;
    } finally {
      clearTimeout(t);
    }
  }

  /** True when an error looks like a network/timeout problem (not a license fault). */
  _isTransient(err) {
    if (!err) return false;
    if (err.code && ['ABORT_ERR', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(err.code)) return true;
    if (err.name === 'AbortError') return true;
    return false;
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /** Current state. */
  getState() {
    return this._state;
  }

  getLicense() {
    return this._license;
  }

  /**
   * Run at boot. Returns one of:
   *   - { state: 'active', license }
   *   - { state: 'needs_activation' }
   *   - { state: 'blocked', reason }
   */
  async checkAtBoot() {
    const stored = this._readStored();
    if (!stored || !stored.token) {
      this._setState(STATE.NEEDS_ACTIVATION);
      return { state: STATE.NEEDS_ACTIVATION };
    }

    this._token = stored.token;
    this._license = stored.license || null;
    this._lastVerifiedAt = stored.lastVerifiedAt || 0;

    // Try to verify online.
    try {
      const r = await this._call('verify', { token: this._token });
      if (r.valid) {
        this._token = r.token;
        this._license = r.license;
        this._lastVerifiedAt = Date.now();
        this._writeStored(this._token, this._license, this._lastVerifiedAt);
        this._setState(STATE.ACTIVE);
        return { state: STATE.ACTIVE, license: this._license };
      }
      throw new Error('not valid');
    } catch (err) {
      // Hard rejection by the server (suspended / cancelled / expired / mismatch)
      if (err.code && ['SUSPENDED', 'CANCELLED', 'EXPIRED', 'DEVICE_MISMATCH', 'NOT_FOUND'].includes(err.code)) {
        this._clearStored();
        this._setState(STATE.BLOCKED, err.code);
        return { state: STATE.BLOCKED, reason: err.code };
      }
      // Transient (offline / timeout) → offline grace window.
      if (this._isTransient(err) && (Date.now() - this._lastVerifiedAt) < OFFLINE_GRACE_MS) {
        this._setState(STATE.ACTIVE);
        return { state: STATE.ACTIVE, license: this._license, offline: true };
      }
      // Offline beyond grace, or unknown error → block.
      this._setState(STATE.BLOCKED, err.code || 'UNVERIFIED');
      return { state: STATE.BLOCKED, reason: err.code || 'UNVERIFIED' };
    }
  }

  /**
   * Activate with a license key entered by the user.
   * Returns { ok: true, license } on success, { ok: false, error, code } on failure.
   */
  async activate(licenseKey) {
    const key = (licenseKey || '').trim();
    if (!key) return { ok: false, error: 'Enter a license key.', code: 'EMPTY' };

    const deviceId = await getDeviceId();
    const machineInfo = await getMachineInfo();

    try {
      const r = await this._call('activate', {
        license_key: key,
        device_id: deviceId,
        machine_info: machineInfo,
      });
      if (!r.ok) throw Object.assign(new Error(r.error || 'Activation failed'), { code: r.code });

      this._token = r.token;
      this._license = r.license;
      this._lastVerifiedAt = Date.now();
      this._writeStored(this._token, this._license, this._lastVerifiedAt);
      this._setState(STATE.ACTIVE);
      return { ok: true, license: this._license };
    } catch (err) {
      return { ok: false, error: err.message, code: err.code || 'ACTIVATION_FAILED' };
    }
  }

  /** Begin the periodic heartbeat. Emits 'blocked' if the license is revoked. */
  startHeartbeat() {
    this.stopHeartbeat();
    const tick = async () => {
      if (this._state !== STATE.ACTIVE || !this._token) return;
      try {
        const r = await this._call('heartbeat', { token: this._token, app_version: APP_VERSION });
        if (r.valid) {
          this._token = r.token;
          this._license = r.license;
          this._lastVerifiedAt = Date.now();
          this._writeStored(this._token, this._license, this._lastVerifiedAt);
          return;
        }
      } catch (err) {
        // Hard revocation → lock immediately.
        if (err.code && ['SUSPENDED', 'CANCELLED', 'EXPIRED', 'DEVICE_MISMATCH', 'NOT_FOUND', 'BAD_TOKEN'].includes(err.code)) {
          this._clearStored();
          this._setState(STATE.BLOCKED, err.code);
          return;
        }
        // Transient → tolerate; offline grace still applies at next boot.
      }
    };
    // Fire one immediately, then on interval.
    tick();
    this._heartbeatTimer = setInterval(tick, HEARTBEAT_INTERVAL_MS);
    if (this._heartbeatTimer.unref) this._heartbeatTimer.unref();
  }

  stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  _setState(newState, reason) {
    const prev = this._state;
    this._state = newState;
    if (prev !== newState) {
      this.emit('state', newState, reason);
      if (newState === STATE.BLOCKED) this.emit('blocked', reason);
    }
  }
}

module.exports = { LicenseClient, STATE };
