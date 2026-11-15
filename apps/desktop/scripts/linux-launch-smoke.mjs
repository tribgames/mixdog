// Headless launch smoke for the packaged Linux AppImage. Run under xvfb-run:
//   node scripts/linux-launch-smoke.mjs <AppImage|executable> <outDir>
// Launches with a fresh profile and a CDP port, waits until the app has started its core (the
// `daemon-service-ready` line of the desktop's diagnostics log, which apps/desktop/src/main/index.ts writes
// once the connection to the core is up), screenshots the main window, and asserts no crash. The app prints
// no boot line on stdout/stderr, so the diagnostics log of the profile is the signal (as in linux-update-smoke.mjs).
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
// The diagnostics events of the app's boot: the core is up / the core could not be started.
const READY_EVENT = 'daemon-service-ready';
const FAILED_EVENT = 'daemon-service-start-failed';
await mkdir(outDir, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'mixdog-smoke-'));
const log = createWriteStream(join(outDir, 'app-stderr.log'));
const diagnosticsFile = join(profile, 'user-data', 'logs', 'desktop-diagnostics.jsonl');
const diagnosticEvents = async () => {
  try {
    return (await readFile(diagnosticsFile, 'utf8')).split('\n').flatMap((line) => {
      try {
        return line ? [JSON.parse(line)] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
};

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
let launchError = null;
child.on('error', (error) => { launchError = error; });
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
  // The uploaded smoke artifact shows why the boot did not complete.
  await copyFile(diagnosticsFile, join(outDir, 'desktop-diagnostics.jsonl')).catch(() => {});
  await sleep(200);
  process.exit(1);
}

const deadline = Date.now() + BOOT_TIMEOUT_MS;
for (;;) {
  if (launchError) await fail(`app could not be launched: ${launchError.message}`);
  const events = await diagnosticEvents();
  if (events.some((event) => event.event === FAILED_EVENT)) await fail(`the app could not start its core (${FAILED_EVENT})`);
  if (events.some((event) => event.event === READY_EVENT)) break;
  if (exited) await fail(`app exited early ${JSON.stringify(exited)}`);
  if (Date.now() > deadline) await fail(`timed out waiting for ${READY_EVENT}`);
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
let shot;
try {
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('CDP open timed out')), 15_000);
    ws.once('open', () => { clearTimeout(timer); res(); });
    ws.once('error', (error) => { clearTimeout(timer); rej(error); });
  });
  shot = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('CDP screenshot timed out')), 15_000);
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg.id !== 1) return;
      clearTimeout(timer);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result.data);
    });
    ws.once('error', (error) => { clearTimeout(timer); rej(error); });
    ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
  });
} catch (error) {
  ws.terminate();
  await fail(`CDP verification failed: ${error.message}`);
}
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
await copyFile(diagnosticsFile, join(outDir, 'desktop-diagnostics.jsonl')).catch(() => {});
console.log('SMOKE OK');
process.exit(0);
