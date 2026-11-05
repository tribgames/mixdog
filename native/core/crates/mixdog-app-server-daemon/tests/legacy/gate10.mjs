// LR §11 gate 10: the real v1.4.5 clients against the 1.4.6 control listener. Run by
// `tests/legacy_clients.rs`; prints one `GATE10 <json>` line.
//
//   node gate10.mjs <tagTree with node_modules> <controlPort> <workDir> <livePid> <barrierDir>
//
// Every request to the listener goes through a recording proxy, so "the core never received
// /stop" is observed, not assumed.
import net from 'node:net';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [tagTree, controlPort, work, livePid, barrierDir] = process.argv.slice(2);
// esbuild comes from the tag tree's node_modules.
const { build } = createRequire(join(tagTree, 'package.json'))('esbuild');
const mod = (rel) => import(pathToFileURL(join(tagTree, rel)).href);
const requests = [];

// ---- recording proxy ----------------------------------------------------------------------
const proxy = net.createServer((client) => {
  const upstream = net.connect(Number(controlPort), '127.0.0.1');
  let first = true;
  client.on('data', (chunk) => {
    if (first) {
      first = false;
      const [method, path] = chunk.toString('latin1').split(' ');
      requests.push(`${method} ${path}`);
    }
    upstream.write(chunk);
  });
  upstream.on('data', (chunk) => client.write(chunk));
  client.on('end', () => upstream.end());
  upstream.on('end', () => client.end());
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
});
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const port = proxy.address().port;

const result = {};
const record = (name, fn) =>
  fn().then(
    (value) => { result[name] = { ok: true, ...value }; },
    (error) => { result[name] = { ok: false, error: String(error?.stack ?? error) }; }
  );

const runtimeRoot = join(work, 'runtime');
mkdirSync(runtimeRoot, { recursive: true });
const discovery = { pid: Number(livePid), endpoints: { session: { port, token: 'legacy-token' } } };
writeFileSync(join(runtimeRoot, 'daemon.json'), JSON.stringify(discovery));

// ---- 1.4.5 TUI/CLI against a serving core: ensureDaemon -> attachSession ---------------------
await record('attachToServingCore', async () => {
  process.env.MIXDOG_RUNTIME_ROOT = runtimeRoot;
  const client = await mod('src/standalone/session-client.mjs');
  const found = await client.ensureDaemon({ attempts: 0, readyTimeoutMs: 15_000 });
  let message = null;
  let statusCode = null;
  try {
    await client.attachSession({ discovery: found, log: () => {} });
  } catch (error) {
    message = error.message;
    statusCode = error.statusCode ?? null;
  }
  return { ensureReturnedDiscovery: Number(found.port) === port, message, statusCode };
});

// ---- 1.4.5 TUI/CLI with no core: the candidates lose the barrier claim -----------------------
await record('noCoreCandidateLine', async () => {
  const dataDir = join(work, 'barrier-data');
  const emptyRuntime = join(work, 'runtime-none');
  mkdirSync(emptyRuntime, { recursive: true });
  cpSync(barrierDir, dataDir, { recursive: true });
  const env = {
    MIXDOG_DATA_DIR: dataDir,
    MIXDOG_HOME: join(work, 'home'),
    MIXDOG_RUNTIME_ROOT: emptyRuntime,
    MIXDOG_DAEMON_SKIP_MEMORY: '1',
    MIXDOG_DISABLE_MCP: '1',
    HOME: join(work, 'home'),
    USERPROFILE: join(work, 'home'),
  };
  Object.assign(process.env, env);
  const client = await mod('src/standalone/session-client.mjs');
  let message = null;
  try {
    await client.ensureDaemon({ attempts: 2, readyTimeoutMs: 90_000, cwd: tagTree, entry: join(tagTree, 'src/standalone/daemon.mjs') });
  } catch (error) {
    message = error.message;
  }
  return { message };
});

// ---- 1.4.5 SSH program against a server with a core -----------------------------------------
await record('sshProgramWithCore', async () => {
  const bundled = join(work, 'ssh-program.mjs');
  await build({
    entryPoints: [join(tagTree, 'apps/desktop/src/main/ssh/remote-install-program.ts')],
    bundle: true, platform: 'node', format: 'esm', outfile: bundled, logLevel: 'silent',
  });
  const { REMOTE_SERVER_LIBRARY } = await import(pathToFileURL(bundled).href);
  const require = createRequire(import.meta.url);
  const library = new Function(
    'require', 'process', 'Buffer',
    `${REMOTE_SERVER_LIBRARY}\nreturn { ensureDaemon, remotePaths };`
  )(require, process, Buffer);
  const home = join(work, 'ssh-home');
  const paths = library.remotePaths(home);
  mkdirSync(paths.runtimeRoot, { recursive: true });
  writeFileSync(paths.discovery, JSON.stringify(discovery));
  try {
    await library.ensureDaemon(paths, { installId: '1.4.5-x', version: '1.4.5', buildHash: 'x' }, join(paths.versions, '1.4.5-x'), 0);
    return { code: null, message: null };
  } catch (error) {
    return { code: error.code ?? null, message: error.message };
  }
});

result.requests = requests;
proxy.close();
process.stdout.write(`GATE10 ${JSON.stringify(result)}\n`, () => process.exit(0));
