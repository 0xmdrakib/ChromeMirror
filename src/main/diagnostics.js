'use strict';

const fs = require('fs');
const path = require('path');

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const FLUSH_DELAY_MS = 40;

class DiagnosticsLog {
  constructor(userDataPath) {
    this.dir = path.join(userDataPath, 'logs');
    this.file = path.join(this.dir, 'chrome-mirror.log');
    this.previousFile = path.join(this.dir, 'chrome-mirror.previous.log');
    this.lastStatus = '';
    this.pending = [];
    this.flushTimer = null;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  write(level, message, detail) {
    try {
      const entry = {
        at: new Date().toISOString(),
        level: String(level || 'info'),
        message: String(message || '').replace(/[\r\n]+/g, ' ').slice(0, 500),
      };
      if (detail && typeof detail === 'object') entry.detail = sanitizeDetail(detail);
      this.pending.push(`${JSON.stringify(entry)}\n`);
      this._scheduleFlush();
    } catch (_) {}
  }

  _scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushSync();
    }, FLUSH_DELAY_MS);
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
  }

  flushSync() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.pending.length) return;
    const batch = this.pending.join('');
    this.pending = [];
    try {
      this._rotateIfNeeded(Buffer.byteLength(batch));
      fs.appendFileSync(this.file, batch, 'utf8');
    } catch (_) {}
  }

  status(status) {
    const summary = {
      running: !!(status && status.running),
      mirroring: !!(status && status.mirroring),
      followers: Array.isArray(status && status.followers)
        ? status.followers.map((follower) => ({
          id: follower.id,
          state: follower.state,
          tabs: follower.tabs,
          queueDepth: follower.queueDepth,
          replayFailures: follower.replayFailures,
        }))
        : [],
    };
    const key = JSON.stringify(summary);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.write('status', 'Mirror session state changed', summary);
  }

  _rotateIfNeeded(incomingBytes = 0) {
    let size = 0;
    try { size = fs.statSync(this.file).size; } catch (_) {}
    if (size + incomingBytes < MAX_LOG_BYTES) return;
    try { fs.unlinkSync(this.previousFile); } catch (_) {}
    fs.renameSync(this.file, this.previousFile);
  }
}

function sanitizeDetail(value, depth = 0) {
  if (depth > 3 || value == null) return value == null ? value : '[trimmed]';
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitizeDetail(item, depth + 1));
  if (typeof value !== 'object') return String(value).slice(0, 300);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (/license|token|key|secret|cookie/i.test(key)) continue;
    output[key] = sanitizeDetail(item, depth + 1);
  }
  return output;
}

module.exports = { DiagnosticsLog, sanitizeDetail, MAX_LOG_BYTES };
