'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const verificationEnv = {
  DATABASE_URL: 'postgresql://test:test@localhost:5432/chrome_mirror',
  BETTER_AUTH_SECRET: 'test-better-auth-secret-32-characters',
  BETTER_AUTH_URL: 'http://localhost:3000',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',
  ADMIN_EMAIL: 'admin@example.com',
  LICENSE_JWT_SECRET: 'test-license-jwt-secret-32-characters',
  LICENSE_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  REDEEM_CODE_PEPPER: 'test-redeem-code-pepper-32-characters',
  NOWPAYMENTS_API_KEY: '',
  NOWPAYMENTS_IPN_SECRET: 'test-nowpayments-secret',
  NOWPAYMENTS_API_URL: 'https://api-sandbox.nowpayments.io/v1',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  NEXT_PUBLIC_GITHUB_REPO: 'https://github.com/0xmdrakib/ChromeMirror',
  NEXT_PUBLIC_DOWNLOAD_URL:
    'https://github.com/0xmdrakib/ChromeMirror/releases/latest',
};

const env = { ...process.env };
for (const [name, value] of Object.entries(verificationEnv)) {
  if (!env[name]) env[name] = value;
}

console.log(
  'verify web build: using non-production placeholders for missing environment variables'
);

const npmCli = [
  process.env.npm_execpath,
  path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  process.env.APPDATA
    ? path.join(process.env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : '',
].find((candidate) => candidate && fs.existsSync(candidate));

if (!npmCli) {
  console.error('verify web build: could not locate the npm CLI');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [npmCli, '--prefix', 'web', 'run', 'build'],
  {
    cwd: root,
    env,
    stdio: 'inherit',
  }
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
