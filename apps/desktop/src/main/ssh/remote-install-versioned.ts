// The immutable install, as server program source.
//
//   ~/.mixdog-remote/versions/<version>-<buildHash>/   one desktop build
//     package.json, src/, apps/desktop/out/main/daemon.cjs, server-deps/
//     node_modules -> ../../deps/<depsKey>/node_modules
//     .install-complete                                  written last
//   ~/.mixdog-remote/deps/<depsHash>-<os>-<arch>-abi<N>/ npm modules, shared
//     node_modules/, .install-complete                    by builds whose
//                                                         lockfile matches
//
// Upload lands in a staging dir, the manifest is verified there, then one
// rename publishes it and the marker is written. A directory without a
// matching marker is never trusted: it is replaced.
//
// npm modules are installed ON the server (`npm ci --omit=dev
// --ignore-scripts` from the lockfile the desktop build generated) rather than
// shipped: the desktop's own node_modules carry the desktop OS's native
// binaries, while npm on the server picks each module's prebuilt optional
// package for the server's platform. --ignore-scripts means no compiler and no
// root; node-pty ships its Linux prebuilds inside its tarball, and on macOS its
// prebuilt binary is fetched with prebuild-install (still no compiler).

export const REMOTE_PTY_PACKAGE = '@homebridge/node-pty-prebuilt-multiarch';
export const REMOTE_NPM_TIMEOUT_MS = 300_000;

export const REMOTE_VERSIONED_SOURCE = String.raw`
const PTY_PACKAGE = ${JSON.stringify(REMOTE_PTY_PACKAGE)};
function versionDirOf(p, installId) {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(String(installId))) fail('install-failed', 'Unsafe install id: ' + installId);
  return path.join(p.versions, installId);
}
function installedState(p, args) {
  const versionDir = versionDirOf(p, args.installId);
  const missing = { installed: false, versionDir, installedVersion: null, depsKey: null, terminalsAvailable: null, terminalsError: null };
  const marker = readJson(path.join(versionDir, '.install-complete'));
  if (!marker || marker.buildHash !== args.buildHash || typeof marker.depsKey !== 'string') return missing;
  const deps = readJson(path.join(p.deps, marker.depsKey, '.install-complete'));
  if (!deps || !fs.existsSync(path.join(versionDir, 'node_modules', PTY_PACKAGE, 'package.json'))) return missing;
  return { installed: true, versionDir, installedVersion: String(marker.version || ''), depsKey: marker.depsKey, terminalsAvailable: deps.terminalsAvailable === true, terminalsError: deps.terminalsError || null };
}
function findNpm() {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  dirs.push(path.dirname(process.execPath));
  for (const dir of dirs) {
    const candidate = path.join(dir, 'npm');
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  return null;
}
function ptyPrebuilds(packageDir, info) {
  try { return fs.readdirSync(path.join(packageDir, 'prebuilds', info.os + '-' + info.arch)); } catch { return []; }
}
/** Load node-pty and run one pty in a child node, so a broken binary cannot
 *  take the installer down. */
function checkTerminals(depsDir, info) {
  const packageDir = path.join(depsDir, 'node_modules', PTY_PACKAGE);
  const probe = "const pty = require(process.argv[1]); const t = pty.spawn('/bin/sh', ['-c', 'exit 0'], {}); t.onExit(() => process.exit(0)); setTimeout(() => process.exit(2), 8000);";
  const run = cp.spawnSync(process.execPath, ['-e', probe, packageDir], { encoding: 'utf8', timeout: 15000 });
  if (!run.error && run.status === 0) return { ok: true, error: null };
  const detail = run.error ? run.error.message : String(run.stderr || '').trim().split('\n').slice(-3).join(' | ') || 'status ' + run.status;
  const prebuilds = ptyPrebuilds(packageDir, info);
  const wanted = 'node.abi' + info.modules + '.node';
  const list = info.os === 'linux'
    ? ' Prebuilt binaries for ' + info.os + '-' + info.arch + ': ' + (prebuilds.join(', ') || 'none') + (prebuilds.includes(wanted) ? '' : ' (none for node ABI ' + info.modules + ')') + '.'
    : '';
  return { ok: false, error: PTY_PACKAGE + ' does not run under node ' + info.node + ' (' + info.os + '-' + info.arch + '): ' + detail + '.' + list + ' Terminals are disabled on this server.' };
}
function ensureDeps(p, depsKey, stagedVersion, info) {
  const dir = path.join(p.deps, depsKey);
  const marker = readJson(path.join(dir, '.install-complete'));
  if (marker) return marker;
  fs.mkdirSync(p.deps, { recursive: true });
  const work = path.join(p.deps, '.staging-' + depsKey + '-' + process.pid + '-' + crypto.randomBytes(4).toString('hex'));
  let published = false;
  try {
    fs.mkdirSync(work);
    for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(stagedVersion, 'server-deps', name), path.join(work, name));
    const npm = findNpm();
    if (!npm) fail('npm-missing', 'npm was not found on the server (PATH=' + process.env.PATH + '); it installs the Mixdog runtime modules. Install Node.js with npm.');
    const npmArgs = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'];
    const run = cp.spawnSync(npm, npmArgs, { cwd: work, encoding: 'utf8', timeout: ${REMOTE_NPM_TIMEOUT_MS}, maxBuffer: 16 * 1024 * 1024, env: Object.assign({}, process.env, { npm_config_update_notifier: 'false' }) });
    if (run.error || run.status !== 0) {
      const detail = run.error ? run.error.message : String(run.stderr || run.stdout || 'status ' + run.status).trim().split('\n').slice(-4).join(' | ');
      fail('deps-install', 'Installing the Mixdog runtime modules on the server failed: ' + detail + '. The server needs access to the npm registry (and github.com for one module); the install retries on the next connect.');
    }
    if (info.os === 'darwin') {
      // macOS prebuilds are release assets, not tarball content: fetch, never compile.
      const fetcher = path.join(work, 'node_modules', 'prebuild-install', 'bin.js');
      if (fs.existsSync(fetcher)) cp.spawnSync(process.execPath, [fetcher], { cwd: path.join(work, 'node_modules', PTY_PACKAGE), encoding: 'utf8', timeout: 120000 });
    }
    const terminals = checkTerminals(work, info);
    removeTree(dir);
    fs.renameSync(work, dir);
    published = true;
    const record = { depsKey, terminalsAvailable: terminals.ok, terminalsError: terminals.error, node: info.node, installedAt: Date.now() };
    writeJsonAtomic(path.join(dir, '.install-complete'), record);
    return record;
  } finally {
    if (!published) removeTree(work);
  }
}
function depsKeyOf(stagedVersion, info) {
  const hash = crypto.createHash('sha256');
  for (const name of ['package.json', 'package-lock.json']) hash.update(fs.readFileSync(path.join(stagedVersion, 'server-deps', name)));
  return hash.digest('hex').slice(0, 16) + '-' + info.os + '-' + info.arch + '-abi' + info.modules;
}
async function ensureInstalled(p, args, upload, info) {
  const current = installedState(p, args);
  if (current.installed) return Object.assign(current, { freshInstall: false });
  if (!upload) fail('install-missing', 'The server install ' + args.installId + ' is missing and must be uploaded.');
  fs.mkdirSync(p.versions, { recursive: true });
  const staging = path.join(p.versions, '.staging-' + args.installId + '-' + process.pid + '-' + crypto.randomBytes(4).toString('hex'));
  let depsKey = null;
  try {
    fs.mkdirSync(staging);
    const manifest = unpackPayload(upload, staging);
    verifyManifest(staging, manifest, args.buildHash);
    depsKey = depsKeyOf(staging, info);
    ensureDeps(p, depsKey, staging, info);
    fs.symlinkSync(path.join(p.deps, depsKey, 'node_modules'), path.join(staging, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.mkdirSync(path.join(staging, 'resources'), { recursive: true });
    // Whatever sits at the final path has no matching marker: never trusted.
    removeTree(current.versionDir);
    fs.renameSync(staging, current.versionDir);
  } catch (error) {
    removeTree(staging);
    if (error instanceof RemoteFail) throw error;
    fail('install-failed', 'Installing ' + args.installId + ' on the server failed: ' + (error && error.message || error));
  }
  writeJsonAtomic(path.join(current.versionDir, '.install-complete'), { version: args.version, buildHash: args.buildHash, depsKey, installedAt: Date.now() });
  return Object.assign(installedState(p, args), { freshInstall: true });
}
`;
