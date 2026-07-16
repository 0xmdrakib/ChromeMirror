'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const files = [
  'src/main/capture-script.js',
  'src/main/device-id.js',
  'src/main/license-client.js',
  'src/main/main.js',
  'src/main/mirror-engine.js',
  'src/main/profiles.js',
  'src/main/replay.js',
  'src/main/window-layout.js',
  'src/preload/preload.js',
  'src/renderer/activate.js',
  'src/renderer/blocked.js',
  'src/renderer/lucide-icons.js',
  'src/renderer/renderer.js',
  'scripts/compile.js',
  'scripts/apply-fuses.js',
];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.resolve(file)], {
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`desktop syntax: ${files.length} files checked`);
