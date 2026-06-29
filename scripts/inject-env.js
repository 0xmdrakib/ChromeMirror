'use strict';

// ============================================================================
// inject-env.js
//
// Replaces build-time placeholders with real Supabase credentials BEFORE
// compilation/packaging. This is run as a prebuild step (see package.json).
//
// Why placeholders instead of env vars at runtime? Because in a packaged app
// there is no shell env. By baking the (public, anon) key into the source and
// then compiling that source to bytecode + obfuscating, the key is embedded but
// not trivially readable. The anon key is designed to be public anyway — all
// real protection is server-side (RLS + service-role key in Edge Functions).
//
// Reads from: a local .env file at the project root (gitignored).
// Writes to: the actual source files in place.
// ============================================================================

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function loadEnv(file) {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = { ...loadEnv('.env'), ...loadEnv('admin/.env') };

const URL = env.SUPABASE_URL || process.env.SUPABASE_URL;
const ANON = env.SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

if (!URL || !ANON) {
  console.error('inject-env: SUPABASE_URL and SUPABASE_ANON_KEY must be set.');
  console.error('Create a .env file at the project root with:');
  console.error('  SUPABASE_URL=https://xxxx.supabase.co');
  console.error('  SUPABASE_ANON_KEY=eyJ...');
  process.exit(1);
}

// --- 1. license-client.js: __SUPABASE_URL__ / __SUPABASE_ANON_KEY__ ----------
const licPath = path.join(root, 'src', 'main', 'license-client.js');
let lic = fs.readFileSync(licPath, 'utf8');
// Restore placeholder form first (idempotent), then inject real value.
lic = lic
  .replace(/const v = '[^']*';\s*\/\/__PH_URL__/, "const v = '__SUPABASE_URL__';//__PH_URL__")
  .replace(/const v = '[^']*';\s*\/\/__PH_KEY__/, "const v = '__SUPABASE_ANON_KEY__';//__PH_KEY__");

// The source uses literal placeholders '__SUPABASE_URL__' / '__SUPABASE_ANON_KEY__'.
// Replace the full string literal so the detection branch collapses to the value.
const beforeLic = lic;
lic = lic
  .replace("'__SUPABASE_URL__'", JSON.stringify(URL))
  .replace("'__SUPABASE_ANON_KEY__'", JSON.stringify(ANON));

if (lic === beforeLic) {
  console.log('inject-env: license-client.js placeholders already resolved or not found (ok).');
}
fs.writeFileSync(licPath, lic);
console.log('inject-env: wrote SUPABASE_URL/ANON_KEY into license-client.js');

// --- 2. admin/admin.js: %%SUPABASE_URL%% / %%SUPABASE_ANON_KEY%% ------------
const adminPath = path.join(root, 'admin', 'admin.js');
let adm = fs.readFileSync(adminPath, 'utf8');
adm = adm
  .replace("'%%SUPABASE_URL%%'", JSON.stringify(URL))
  .replace("'%%SUPABASE_ANON_KEY%%'", JSON.stringify(ANON));
fs.writeFileSync(adminPath, adm);
console.log('inject-env: wrote SUPABASE_URL/ANON_KEY into admin/admin.js');

console.log('inject-env: done.');
