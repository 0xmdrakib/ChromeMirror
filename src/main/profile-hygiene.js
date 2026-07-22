'use strict';

const fs = require('fs');
const path = require('path');

const SESSION_RESTORE_RELATIVE_PATHS = [
  path.join('Default', 'Sessions'),
  path.join('Default', 'Current Session'),
  path.join('Default', 'Current Tabs'),
  path.join('Default', 'Last Session'),
  path.join('Default', 'Last Tabs'),
];

function timestamp(now = Date.now()) {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function ensureSafeChild(child, parent, label) {
  if (!isInside(child, parent)) {
    throw new Error(`${label || 'path'} escaped the expected profile directory`);
  }
}

function moveWithFallback(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.renameSync(source, destination);
    return;
  } catch (error) {
    if (!['EXDEV', 'EPERM', 'EACCES'].includes(error.code)) throw error;
  }
  fs.cpSync(source, destination, { recursive: true, force: true });
  fs.rmSync(source, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
}

function cleanProfileSessionRestore(profileDir, { now = Date.now } = {}) {
  if (!profileDir) return { profileDir: null, cleaned: [], backupDir: null };

  const resolvedProfileDir = path.resolve(profileDir);
  const backupDir = path.join(
    path.dirname(resolvedProfileDir),
    '.session-backups',
    `${path.basename(resolvedProfileDir)}-${timestamp(now())}`
  );
  const cleaned = [];

  for (const relativePath of SESSION_RESTORE_RELATIVE_PATHS) {
    const target = path.resolve(resolvedProfileDir, relativePath);
    ensureSafeChild(target, resolvedProfileDir, 'session restore path');
    if (!fs.existsSync(target)) continue;

    const destination = path.resolve(backupDir, relativePath);
    ensureSafeChild(destination, backupDir, 'session restore backup path');
    moveWithFallback(target, destination);
    cleaned.push({
      relativePath: relativePath.replace(/\\/g, '/'),
      backupPath: destination,
    });
  }

  return {
    profileDir: resolvedProfileDir,
    cleaned,
    backupDir: cleaned.length ? backupDir : null,
  };
}

function resetProfileDirectory(profileDir, { now = Date.now } = {}) {
  if (!profileDir) throw new Error('profileDir is required');
  const resolvedProfileDir = path.resolve(profileDir);
  const parentDir = path.dirname(resolvedProfileDir);
  const backupDir = path.join(
    parentDir,
    '.profile-backups',
    `${path.basename(resolvedProfileDir)}-${timestamp(now())}`
  );

  if (fs.existsSync(resolvedProfileDir)) {
    ensureSafeChild(backupDir, parentDir, 'profile backup path');
    moveWithFallback(resolvedProfileDir, backupDir);
  }
  fs.mkdirSync(resolvedProfileDir, { recursive: true });

  return {
    profileDir: resolvedProfileDir,
    backupDir: fs.existsSync(backupDir) ? backupDir : null,
  };
}

module.exports = {
  cleanProfileSessionRestore,
  resetProfileDirectory,
  SESSION_RESTORE_RELATIVE_PATHS,
};
