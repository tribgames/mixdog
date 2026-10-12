// Headless launch smoke for the packaged Linux AppImage. Run under xvfb-run:
//   node scripts/linux-launch-smoke.mjs <AppImage|executable> <outDir>
// Launches with a fresh profile and a CDP port, waits for the boot-ready
// signal on stderr, screenshots the main window, and asserts no crash.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';

const [appImageArg, outDirArg] = process.argv.slice(2);
if (!appImageArg || !outDirArg) throw new Error('usage: linux-launch-smoke.mjs <AppImage> <outDir>');
const appImage = resolve(appImageArg);
const outDir = resolve(outDirArg);
const port = 9333;
// Extra launcher flags, e.g. SMOKE_LAUNCH_ARGS=--appimage-extract-and-run. Empty by default so an AppImage is mounted through its own (FUSE) runtime.
const launchArgs = (process.env.SMOKE_LAUNCH_ARGS ?? '').split(' ').filter(Boolean);
// SMOKE_SANDBOX=1 launches with the Chromium sandbox enabled (installed .deb); otherwise --no-sandbox is passed (AppImage on CI runners, root containers).
const sandbox = process.env.SMOKE_SANDBOX === '1';
console.log(`sandbox: ${sandbox ? 'enabled' : 'disabled (--no-sandbox)'}`);
const BOOT_TIMEOUT_MS = 180_000;
await mkdir(outDir, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'mixdog-smoke-'));
const log = createWriteStream(join(outDir, 'app-stderr.log'));

const child = spawn(
  appImage,
  [...launchArgs, ...(sandbox ? [] : ['--no-sandbox']), `--remote-debugging-port=${port}`],
  {
    env: {
      ...process.env,
      MIXDOG_DESKTOP_USER_DATA: join(profile, 'user-data'),
      HOME: join(profile, 'home'),
      XDG_CACHE_HOME: join(profile, 'home', '.cache'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  }
);
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fail(message) {
  console.error(`SMOKE FAIL: ${message}`);
  killTree('SIGKILL');
  log.end();
  await sleep(200);
  process.exit(1);
}

const deadline = Date.now() + BOOT_TIMEOUT_MS;
while (!/transport-ready/.test(output)) {
  if (exited) await fail(`app exited early ${JSON.stringify(exited)}`);
  if (Date.now() > deadline) await fail('timed out waiting for transport-ready');
  await sleep(500);
}
console.log('boot-ready signal observed');

async function pageTarget() {
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  return fail('no page target on CDP port');
}
const target = await pageTarget();
await sleep(3000); // let first paint settle
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.once('open', res);
  ws.once('error', rej);
});
const shot = await new Promise((res, rej) => {
  ws.once('message', (data) => {
    const msg = JSON.parse(String(data));
    msg.error ? rej(new Error(msg.error.message)) : res(msg.result.data);
  });
  ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
});
ws.close();
const png = Buffer.from(shot, 'base64');
await writeFile(join(outDir, 'main-window.png'), png);
console.log(`screenshot ${png.length} bytes, page ${target.url}`);
if (png.length < 5000) await fail('screenshot suspiciously small');

await sleep(2000);
if (exited) await fail(`app exited after boot ${JSON.stringify(exited)}`);
if (/Segmentation fault|FATAL:|renderer.*crash|render-process-gone/i.test(output)) {
  await fail('crash markers in stderr');
}
killTree('SIGTERM');
await sleep(1500);
killTree('SIGKILL');
log.end();
console.log('SMOKE OK');
process.exit(0);
