'use strict';

// ============================================================================
// compile.js — prebuild transform
//
// Produces a hardened copy of src/ in .build/app/ that electron-builder packs:
//
//   src/main/*.js          → .build/app/main/*.jsc   (V8 bytecode via bytenode)
//                          + a tiny main-loader.js that requires them
//   src/preload/preload.js → .build/app/preload/preload.js (obfuscated; can't
//                            be bytecode because it runs in a sandboxed world)
//   src/renderer/**        → copied as-is, EXCEPT renderer.js which is
//                            obfuscated (it's plain JS in the renderer)
//
// The original src/ is left untouched. package.json's electron-builder `files`
// points at .build/app so only hardened output ships.
// ============================================================================

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const OUT = path.join(root, 'build-app');
const SRC = path.join(root, 'src');

let bytenode = null;
let JavaScriptObfuscator = null;
try { bytenode = require('bytenode'); } catch (_) {}
try { JavaScriptObfuscator = require('javascript-obfuscator'); } catch (_) {}

const OBFUSCATE = !!JavaScriptObfuscator;
const BYTECODE = !!bytenode;

if (!BYTECODE)     console.warn('compile: bytenode not installed — skipping bytecode (DEV ONLY).');
if (!OBFUSCATE)    console.warn('compile: javascript-obfuscator not installed — skipping obfuscation (DEV ONLY).');

const OBFUSCATOR_OPTS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,
  stringArray: true,
  stringArrayThreshold: 0.75,
  stringArrayEncoding: ['base64'],
  stringArrayWrappersCount: 2,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  selfDefending: false,
  disableConsoleOutput: false,
  target: 'node',
};

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function rmrf(p) {
  fs.rmSync(p, {
    recursive: true,
    force: true,
    // Windows can keep freshly used build files briefly locked while
    // antivirus/indexing catches up. Retry instead of silently continuing
    // with a half-removed staging directory.
    maxRetries: 6,
    retryDelay: 150,
  });
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyDir(srcDir, destDir) {
  ensureDir(destDir);
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(destDir, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else copyFile(s, d);
  }
}

function obfuscateSource(code, filePath) {
  if (!OBFUSCATE) return code;
  try {
    return JavaScriptObfuscator.obfuscate(code, { ...OBFUSCATOR_OPTS, inputFileName: filePath }).getObfuscatedCode();
  } catch (e) {
    console.warn(`compile: obfuscation failed for ${filePath}: ${e.message}`);
    return code;
  }
}

// ---------------------------------------------------------------------------
(async () => {
  console.log('compile: cleaning .build/app');
  rmrf(OUT);
  ensureDir(OUT);

  // --- 1. main process: bytecode-compile each .js ----------------------------
  const mainDir = path.join(SRC, 'main');
  const outMainDir = path.join(OUT, 'main');
  ensureDir(outMainDir);

  // We compile only specific core main/*.js to .jsc and write a thin .js shim.
  // The rest are copied as obfuscated or plain javascript depending on whether Playwright needs to serialize them.
  const mainFiles = fs.readdirSync(mainDir).filter((f) => f.endsWith('.js'));
  const bytecodeFiles = ['main.js', 'license-client.js'];
  const dontObfuscateFiles = ['capture-script.js', 'replay.js', 'mirror-engine.js'];
  const compiledShims = [];

  for (const file of mainFiles) {
    const srcPath = path.join(mainDir, file);
    const code = fs.readFileSync(srcPath, 'utf8');
    const dest = path.join(outMainDir, file);

    const shouldCompile = BYTECODE && bytecodeFiles.includes(file);

    if (shouldCompile) {
      const jscPath = path.join(outMainDir, file.replace(/\.js$/, '.jsc'));
      // Compile to a temporary .js (obfuscated first), then to .jsc.
      const obfCode = obfuscateSource(code, file);
      const tempJsPath = jscPath + '.temp.js';
      fs.writeFileSync(tempJsPath, obfCode, 'utf8');
      try {
        await bytenode.compileFile({
          filename: tempJsPath,
          output: jscPath,
          compileAsModule: true
        });
      } finally {
        try { fs.unlinkSync(tempJsPath); } catch (_) {}
      }

      // Shim that loads the bytecode at runtime.
      const baseName = file.replace(/\.js$/, '');
      const shimName = file === 'main.js' ? 'main-loader.js' : file;
      const shimPath = path.join(outMainDir, shimName);
      fs.writeFileSync(shimPath,
        `// Auto-generated loader (compiled build).\n` +
        `require('bytenode');\n` +
        `module.exports = require('./${baseName}.jsc');\n`
      );
      compiledShims.push(shimName);
      console.log(`compile: main/${file} → ${path.basename(jscPath)} + ${shimName}`);
    } else {
      const shouldObfuscate = OBFUSCATE && !dontObfuscateFiles.includes(file);
      const finalCode = shouldObfuscate ? obfuscateSource(code, file) : code;
      fs.writeFileSync(dest, finalCode);
      compiledShims.push(file);
      console.log(`compile: main/${file} → ${file} (${shouldObfuscate ? 'obfuscated' : 'plain'})`);
    }
  }

  // --- 2. preload: obfuscate only (sandboxed world can't load bytecode cleanly) -
  const preloadSrc = path.join(SRC, 'preload', 'preload.js');
  const outPreloadDir = path.join(OUT, 'preload');
  ensureDir(outPreloadDir);
  const preloadCode = fs.readFileSync(preloadSrc, 'utf8');
  fs.writeFileSync(path.join(outPreloadDir, 'preload.js'), obfuscateSource(preloadCode, 'preload.js'));
  console.log('compile: preload/preload.js (obfuscated)');

  // --- 3. renderer: copy assets, obfuscate JS files --------------------------
  const rendererSrc = path.join(SRC, 'renderer');
  const outRendererDir = path.join(OUT, 'renderer');
  copyDir(rendererSrc, outRendererDir);

  const rendererFiles = ['renderer.js', 'license-key.js', 'activate.js', 'blocked.js'];
  for (const file of rendererFiles) {
    const filePath = path.join(outRendererDir, file);
    if (fs.existsSync(filePath)) {
      const rc = fs.readFileSync(filePath, 'utf8');
      fs.writeFileSync(filePath, obfuscateSource(rc, file));
      console.log(`compile: renderer/${file} (obfuscated)`);
    }
  }

  // --- 4. Copy bytenode into the output so the require('bytenode') resolves ---
  if (BYTECODE) {
    // electron-builder will include node_modules from the project root by default,
    // so bytenode resolves from there. We just make sure it's a dependency.
  }

  // --- 5. Write a hardened package.json for the build ------------------------
  const licenseApiUrl = String(
    process.env.LICENSE_API_URL || 'https://chromemirror.rakibhq.xyz/api/v1/license'
  ).replace(/\/$/, '');
  fs.writeFileSync(
    path.join(outMainDir, 'runtime-config.json'),
    JSON.stringify({ licenseApiUrl }, null, 2)
  );
  console.log('compile: wrote main/runtime-config.json');

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const buildPkg = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    author: pkg.author,
    license: pkg.license,
    // The new entry is the main-loader shim.
    main: 'main/main-loader.js',
    dependencies: pkg.dependencies, // playwright-core + (bytenode at runtime)
  };
  fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify(buildPkg, null, 2));
  console.log('compile: wrote build-app/package.json (main: main/main-loader.js)');

  console.log('compile: done. Output in build-app/');
  process.exit(0);
})().catch(err => {
  console.error('compile: failed:', err);
  process.exit(1);
});
