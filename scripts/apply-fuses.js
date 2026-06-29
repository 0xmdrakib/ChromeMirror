'use strict';

// ============================================================================
// apply-fuses.js — post-build hardening
//
// Runs AFTER electron-builder has produced the unpacked app in
// dist/win-unpacked/. Flips Electron "fuses" — compile-time flags baked into
// the Electron binary — to:
//
//   - enable asar integrity validation (tampered app.asar ⇒ won't launch)
//   - require loading the app from asar (no loose-file substitution)
//   - disable `--inspect` / `--remote-debugging-port` / running as a node bin
//   - disable cookie encryption by the OS keychain (not relevant, default ok)
//
// Fuses are the single most effective free protection against the trivial
// "unpack app.asar, edit the JS, repack" attack, because the shipped binary
// validates the asar hash before executing anything inside it.
//
// Usage:  node scripts/apply-fuses.js
// Run this as the last step of `npm run dist` (see package.json "postdist").
// ============================================================================

const path = require('path');
const fs = require('fs');

const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

const root = path.join(__dirname, '..');
const electronExe = path.join(root, 'dist', 'win-unpacked', 'Chrome Mirror.exe');

if (!fs.existsSync(electronExe)) {
  console.warn(`apply-fuses: ${electronExe} not found — nothing to do.`);
  console.warn('           (Run `npm run dist` first, which triggers this as postdist.)');
  process.exit(0);
}

flipFuses(electronExe, {
  version: FuseVersion.V1,
  resetAdHocDarwinSignature: false, // Windows — n/a
  override: {
    [FuseV1Options.RunAsNode]: false,                          // block `ELECTRON_RUN_AS_NODE`
    [FuseV1Options.EnableCookieEncryption]: false,             // app doesn't use Electron cookies
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false, // ignore NODE_OPTIONS
    [FuseV1Options.EnableNodeCliInspectArguments]: false,      // block --inspect / --inspect-brk
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,  // ★ validate app.asar hash
    [FuseV1Options.OnlyLoadAppFromAsar]: true,                  // ★ no loose app dir fallback
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  },
})
  .then(() => console.log('apply-fuses: fuses applied to Chrome Mirror.exe ✓'))
  .catch((e) => {
    console.error('apply-fuses: failed —', e.message);
    process.exit(1);
  });
