'use strict';

// ============================================================================
// Device fingerprinting for Windows.
//
// Combines several stable, hardware-backed identifiers into a single SHA-256
// hash. No native modules, no paid dependencies — only built-in `child_process`
// calls to Windows commands. If one source fails (e.g. wmic removed on newer
// builds), the others keep the fingerprint stable.
//
// Sources:
//   1. HKLM MachineGuid  (stable across OS reinstalls on same hardware? NO —
//      it resets on OS reinstall, but stable across app runs / updates.)
//   2. BIOS/SMBIOS UUID  (motherboard UUID — survives OS reinstalls)
//   3. C: volume serial  (changes if C: is reformatted — a secondary signal)
//
// We also expose richer machine_info (hostname, CPU, OS) for the admin's audit
// log — that data is NOT part of the binding hash, only for human debugging.
// ============================================================================

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function run(cmd, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolve(err ? '' : (stdout || '').toString());
    });
  });
}

/** Pull the MachineGuid from the registry. */
async function machineGuid() {
  const out = await run('reg.exe', [
    'query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid',
  ]);
  const m = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{30,})/i.exec(out || '');
  return m ? m[1].trim() : '';
}

/** SMBIOS/baseboard UUID via PowerShell (preferred over deprecated wmic). */
async function smbiosUuid() {
  // Try PowerShell first (wmic is deprecated/removed on Windows 11 24H2+).
  const ps = await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '(Get-CimInstance Win32_ComputerSystemProduct).UUID',
  ], 6000);
  const cleaned = (ps || '').trim();
  if (cleaned && /^[0-9a-fA-F-]{30,}$/.test(cleaned) && !/^0+-0+$/.test(cleaned)) {
    return cleaned;
  }
  // Fallback: wmic (older systems).
  const w = await run('wmic.exe', ['csproduct', 'get', 'UUID']);
  const m = /([0-9a-fA-F-]{30,})/i.exec(w || '');
  const v = m ? m[1].trim() : '';
  return v && !/^0+-0+$/.test(v) ? v : '';
}

/** C: volume serial number (e.g. "ABCD-1234"). */
async function volumeSerial() {
  const out = await run('cmd.exe', ['/c', 'vol', 'C:']);
  const m = /([0-9A-Fa-f]{4}-[0-9A-Fa-f]{4})/.exec(out || '');
  return m ? m[1].toUpperCase() : '';
}

/**
 * Compute the stable device id. Format: 32 hex chars (SHA-256 truncated).
 * Caches the result so repeated calls are free.
 */
let _cache = null;
async function getDeviceId(storePath, preferredId) {
  if (_cache) return _cache;

  // Existing signed activation claims are authoritative during migration.
  // Persisting that id prevents a temporarily unavailable WMI/registry query
  // from making the same PC look like a different computer on a later run.
  if (isDeviceId(preferredId)) {
    _cache = String(preferredId).toLowerCase();
    persistDeviceId(storePath, _cache);
    return _cache;
  }
  const persisted = readDeviceId(storePath);
  if (persisted) {
    _cache = persisted;
    return _cache;
  }

  const parts = await Promise.all([machineGuid(), smbiosUuid(), volumeSerial()]);
  const present = parts.filter(Boolean);
  if (!present.length) {
    // Last-resort fallback so the app still has *something* to bind to.
    present.push(os.hostname() || 'unknown');
    present.push(String((os.networkInterfaces() && Object.keys(os.networkInterfaces()).join('|')) || 'nics'));
  }

  // Hash only identifiers that were actually returned. The result is stored
  // immediately, so later command timeouts cannot change this installation's
  // binding id.
  const material = present.join('|');
  _cache = crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
  persistDeviceId(storePath, _cache);
  return _cache;
}

function isDeviceId(value) {
  return typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value);
}

function readDeviceId(storePath) {
  if (!storePath) return null;
  try {
    const value = fs.readFileSync(storePath, 'utf8').trim();
    return isDeviceId(value) ? value.toLowerCase() : null;
  } catch (_) {
    return null;
  }
}

function persistDeviceId(storePath, value) {
  if (!storePath || !isDeviceId(value)) return false;
  const tempPath = `${storePath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(tempPath, String(value).toLowerCase(), { encoding: 'utf8', mode: 0o600 });
    try { fs.renameSync(tempPath, storePath); } catch (_) {
      try { fs.unlinkSync(storePath); } catch (_) {}
      fs.renameSync(tempPath, storePath);
    }
    return true;
  } catch (_) {
    try { fs.unlinkSync(tempPath); } catch (_) {}
    return false;
  }
}

/** Richer, non-binding machine info for the admin audit log. */
async function getMachineInfo() {
  const cpus = os.cpus() || [];
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    osRelease: os.release(),
    cpu: cpus[0] ? cpus[0].model : 'unknown',
    cpuCount: cpus.length,
    memGb: Math.round((os.totalmem() / 1024 / 1024 / 1024) * 10) / 10,
    appTs: Date.now(),
  };
}

module.exports = { getDeviceId, getMachineInfo, isDeviceId, readDeviceId, persistDeviceId };
