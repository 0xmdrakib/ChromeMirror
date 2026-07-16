'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const listed = spawnSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: root, encoding: 'utf8' }
);

if (listed.status !== 0) {
  process.stderr.write(listed.stderr || 'Unable to list repository files.\n');
  process.exit(listed.status || 1);
}

const textExtensions = new Set([
  '', '.css', '.env', '.example', '.html', '.js', '.json', '.jsx', '.md',
  '.mjs', '.sql', '.toml', '.ts', '.tsx', '.txt', '.yaml', '.yml',
]);
const findings = [];

function record(file, label, index, text) {
  const line = text.slice(0, index).split(/\r?\n/).length;
  findings.push(`${file}:${line} ${label}`);
}

function isPlaceholder(value) {
  const normalized = value.trim().replace(/^['"]|['"]$/g, '');
  return (
    !normalized ||
    /^(?:password|secret|token|key|changeme|replace-me)$/i.test(normalized) ||
    /^(?:test(?:[-_]|$)|your[-_]|example|generate-a-|base64-encoded-|<|\$\{|process\.env)/i.test(normalized)
  );
}

for (const file of listed.stdout.split('\0').filter(Boolean)) {
  const absolute = path.resolve(root, file);
  if (!absolute.startsWith(root + path.sep) || !fs.existsSync(absolute)) continue;
  if (!textExtensions.has(path.extname(file).toLowerCase())) continue;

  const buffer = fs.readFileSync(absolute);
  if (buffer.includes(0)) continue;
  const text = buffer.toString('utf8');

  const fixedPatterns = [
    ['private key material', /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g],
    ['GitHub access token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g],
    ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g],
    ['Google OAuth client secret', /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/g],
    ['compact JWT value', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ];

  for (const [label, pattern] of fixedPatterns) {
    for (const match of text.matchAll(pattern)) record(file, label, match.index, text);
  }

  const connectionPattern = /\bpostgres(?:ql)?:\/\/[^:\s/]+:([^@\s/]+)@[^\s"'<>]+/gi;
  for (const match of text.matchAll(connectionPattern)) {
    if (!isPlaceholder(match[1])) record(file, 'database URL with embedded password', match.index, text);
  }

  const assignmentPattern =
    /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY)[A-Z0-9_]*)\s*=\s*([^\r\n#]*)/gm;
  for (const match of text.matchAll(assignmentPattern)) {
    if (!isPlaceholder(match[2])) record(file, `non-placeholder ${match[1]}`, match.index, text);
  }
}

if (findings.length) {
  console.error('Potential secrets found:');
  for (const finding of findings) console.error(`  ${finding}`);
  process.exit(1);
}

console.log('secret scan: no credential-like values found');
