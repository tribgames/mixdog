// Headless update-path smoke for a packaged Linux build (no publishing).
//   node scripts/linux-update-smoke.mjs <executable> <feedDir> <expectedVersion> <AppImage|deb> <outDir>
// Serves <feedDir> (latest-linux*.yml plus the N+1 packages) from a loopback
// HTTP server with Range support, launches the installed/older build with
// MIXDOG_UPDATER_DEV_FEED pointing at it, waits for the updater to reach
// `ready` for <expectedVersion>, then checks the file electron-updater
// downloaded: right extension (AppImage vs the .deb DebUpdater fetches) and
// the sha512 the feed declares (electron-updater itself also rejects a
// mismatching download before reporting `ready`).
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
const log = createWriteStream(join(outDir, `update-${ext}-stderr.log`));
const child = spawn(exe, [...launchArgs, ...(sandbox ? [] : ['--no-sandbox'])], {
  env: {
    ...process.env,
    HOME: home,
    XDG_CACHE_HOME: join(home, '.cache'),
    MIXDOG_DESKTOP_USER_DATA: join(profile, 'user-data'),
    MIXDOG_UPDATER_DEV_FEED: `http://127.0.0.1:${feedPort}`,
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
async function fail(message) {
  console.error(`UPDATE SMOKE FAIL: ${message}`);
  killTree('SIGKILL');
  log.end();
  await sleep(200);
  process.exit(1);
}

const deadline = Date.now() + 240_000;
while (!/status: 'ready'/.test(output)) {
  if (/status: 'error'/.test(output)) await fail(`updater reported an error: ${output.match(/status: 'error'[^}]*/)?.[0]}`);
  if (/status: 'up-to-date'/.test(output)) await fail('updater found no newer version in the feed');
  if (exited) await fail(`app exited early ${JSON.stringify(exited)}`);
  if (Date.now() > deadline) await fail('timed out waiting for updater ready');
  await sleep(1000);
}
if (!output.includes(`version: '${expectedVersion}'`)) await fail(`ready state is not for ${expectedVersion}`);
console.log(`updater ready for ${expectedVersion}`);

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
}
const downloaded = (await walk(join(home, '.cache'))).filter((file) => file.endsWith(`.${ext}`));
if (downloaded.length !== 1) await fail(`expected one downloaded .${ext} under ~/.cache, found ${JSON.stringify(downloaded)}`);
const [file] = downloaded;

const feedName = process.arch === 'arm64' ? 'latest-linux-arm64.yml' : 'latest-linux.yml';
const feed = await readFile(join(feedDir, feedName), 'utf8');
const entries = [...feed.matchAll(/-\s+url:\s*(\S+)\s+sha512:\s*(\S+)/g)].map((m) => ({ url: m[1], sha512: m[2] }));
const entry = entries.find((e) => e.url.endsWith(`.${ext}`));
if (!entry) await fail(`${feedName} has no .${ext} entry: ${JSON.stringify(entries)}`);
const digest = createHash('sha512').update(await readFile(file)).digest('base64');
if (digest !== entry.sha512) await fail(`sha512 mismatch for ${file}`);
console.log(`downloaded ${file} (${(await stat(file)).size} bytes), sha512 matches ${feedName}`);
await writeFile(join(outDir, `update-${ext}-downloaded.path`), file);

killTree('SIGTERM');
await sleep(1500);
killTree('SIGKILL');
log.end();
server.close();
console.log('UPDATE SMOKE OK');
process.exit(0);
