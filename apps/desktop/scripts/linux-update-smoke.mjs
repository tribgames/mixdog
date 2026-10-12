// Headless update-path smoke for a packaged Linux build: the app's own updater
// must download, verify, install and relaunch the next version (no publishing).
//   node scripts/linux-update-smoke.mjs <executable> <feedDir> <expectedVersion> <AppImage|deb> <outDir>
// Serves <feedDir> (latest-linux*.yml plus the N+1 packages) from a loopback
// HTTP server with Range support and launches the older build with
// MIXDOG_UPDATER_DEV_FEED pointing at it and MIXDOG_UPDATER_DEV_AUTO_INSTALL=1
// (the app installs as soon as the update is `ready`, as the Settings button
// would). Then it waits until a *different* process writes app-ready
// diagnostics with appVersion === <expectedVersion>:
//   AppImage: AppImageUpdater replaced the AppImage file ($APPIMAGE) and
//             spawned the new file; its sha512 must equal the feed's.
//   deb:      DebUpdater ran dpkg through sudo/pkexec and app.relaunch()ed the
//             installed binary; the downloaded .deb's sha512 must equal the feed's.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [exeArg, feedArg, expectedVersion, ext, outArg] = process.argv.slice(2);
if (!exeArg || !feedArg || !expectedVersion || !['AppImage', 'deb'].includes(ext) || !outArg) {
  throw new Error('usage: linux-update-smoke.mjs <executable> <feedDir> <expectedVersion> <AppImage|deb> <outDir>');
}
const exe = resolve(exeArg);
const feedDir = resolve(feedArg);
const outDir = resolve(outArg);
const feedPort = 9444;
const sandbox = process.env.SMOKE_SANDBOX === '1';
const launchArgs = (process.env.SMOKE_LAUNCH_ARGS ?? '').split(' ').filter(Boolean);
await mkdir(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createServer(async (req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  const file = join(feedDir, name);
  if (name.includes('..')) return void res.writeHead(400).end();
  let size;
  try {
    size = (await stat(file)).size;
  } catch {
    console.log(`feed 404 ${req.method} ${req.url}`);
    return void res.writeHead(404).end();
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range) {
    const start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
    const end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
    });
    return void (req.method === 'HEAD' ? res.end() : createReadStream(file, { start, end }).pipe(res));
  }
  res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' });
  console.log(`feed 200 ${req.method} ${req.url}`);
  req.method === 'HEAD' ? res.end() : createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(feedPort, '127.0.0.1', r));

const profile = await mkdtemp(join(tmpdir(), 'mixdog-update-'));
const home = join(profile, 'home');
const diagnosticsFile = join(profile, 'user-data', 'logs', 'desktop-diagnostics.jsonl');
const log = createWriteStream(join(outDir, `update-${ext}-stderr.log`));
const child = spawn(exe, [...launchArgs, ...(sandbox ? [] : ['--no-sandbox'])], {
  env: {
    ...process.env,
    HOME: home,
    XDG_CACHE_HOME: join(home, '.cache'),
    MIXDOG_DESKTOP_USER_DATA: join(profile, 'user-data'),
    MIXDOG_UPDATER_DEV_FEED: `http://127.0.0.1:${feedPort}`,
    MIXDOG_UPDATER_DEV_AUTO_INSTALL: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
let exited = null;
let output = '';
child.on('exit', (code, signal) => {
  exited = { code, signal };
});
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (chunk) => {
    output += chunk;
    log.write(chunk);
  });
}
const killTree = (sig) => {
  try {
    process.kill(-child.pid, sig);
  } catch {}
};
const killPid = (pid, sig) => {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, sig);
    } catch {}
  }
};
let relaunchedPid = 0;
const cleanup = async () => {
  killTree('SIGTERM');
  if (relaunchedPid) killPid(relaunchedPid, 'SIGTERM');
  await sleep(1500);
  killTree('SIGKILL');
  if (relaunchedPid) killPid(relaunchedPid, 'SIGKILL');
  log.end();
  server.close();
};
async function fail(message) {
  console.error(`UPDATE SMOKE FAIL: ${message}`);
  await cleanup();
  process.exit(1);
}

const events = async () => {
  try {
    return (await readFile(diagnosticsFile, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
};
// Only the updater's own state lines count (the boot-phase log also prints status: 'ready').
const updaterState = (status) =>
  output.match(new RegExp(`Mixdog updater status: \\{[^}]*status: '${status}'[^}]*\\}`))?.[0];

const deadline = Date.now() + 360_000;
let oldBoot;
let newBoot;
while (!newBoot) {
  const ready = (await events()).filter((e) => e.event === 'app-ready');
  oldBoot ??= ready.find((e) => e.appVersion !== expectedVersion);
  newBoot = ready.find((e) => e.appVersion === expectedVersion && e.pid !== oldBoot?.pid);
  if (newBoot) break;
  if (updaterState('error')) await fail(`updater reported an error: ${updaterState('error')}`);
  if (updaterState('up-to-date')) await fail('updater found no newer version in the feed');
  if (
    /dev auto-install failed|updater install launch failed|Cannot download (?!differentially)|ERR_UPDATER/.test(output)
  ) {
    await fail('updater install failed (see update log)');
  }
  if (exited && !updaterState('installing')) await fail(`app exited before installing ${JSON.stringify(exited)}`);
  if (Date.now() > deadline) await fail('timed out waiting for the relaunched app to report the new version');
  await sleep(1000);
}
if (!oldBoot) await fail('never saw the old version boot (app-ready diagnostics missing)');
relaunchedPid = newBoot.pid;
console.log(`old pid ${oldBoot.pid} v${oldBoot.appVersion} -> relaunched pid ${newBoot.pid} v${newBoot.appVersion}`);
if (!updaterState('ready')?.includes(`version: '${expectedVersion}'`))
  await fail(`no ready state for ${expectedVersion}`);
if (!updaterState('installing')) await fail('updater never reported the installing state');
const installer = output.match(/Running as (?:root|non-root user)[^\n]*/)?.[0];
console.log(`installer path: ${installer ?? '(AppImage replace)'}`);
if (ext === 'deb' && !installer) await fail('DebUpdater did not log its sudo/root install command');

const feedName = process.arch === 'arm64' ? 'latest-linux-arm64.yml' : 'latest-linux.yml';
const feed = await readFile(join(feedDir, feedName), 'utf8');
const entries = [...feed.matchAll(/-\s+url:\s*(\S+)\s+sha512:\s*(\S+)/g)].map((m) => ({ url: m[1], sha512: m[2] }));
const entry = entries.find((e) => e.url.endsWith(`.${ext}`));
if (!entry) await fail(`${feedName} has no .${ext} entry: ${JSON.stringify(entries)}`);
const sha512 = async (file) =>
  createHash('sha512')
    .update(await readFile(file))
    .digest('base64');

let installed;
if (ext === 'AppImage') {
  installed = exe; // AppImageUpdater overwrote this file (no version in its name)
} else {
  const found = (await readdir(join(home, '.cache'), { recursive: true }).catch(() => []))
    .filter((path) => path.endsWith('.deb'))
    .map((path) => join(home, '.cache', path));
  if (found.length !== 1) await fail(`expected one downloaded .deb under ~/.cache, found ${JSON.stringify(found)}`);
  installed = found[0];
}
if ((await sha512(installed)) !== entry.sha512) await fail(`sha512 mismatch for ${installed} against ${feedName}`);
console.log(`${installed} (${(await stat(installed)).size} bytes) sha512 matches ${feedName}`);
await writeFile(join(outDir, `update-${ext}-installed.path`), installed);
console.log(
  `relaunched process ${newBoot.pid} is alive: ${(() => {
    try {
      process.kill(newBoot.pid, 0);
      return true;
    } catch {
      return false;
    }
  })()}`
);
await cleanup();
console.log('UPDATE SMOKE OK');
process.exit(0);
