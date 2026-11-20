// Upgrade check: does the built desktop, started on a converted profile whose runtime root still holds the discovery file
// of an ended 1.4.5 daemon, replace it with a core of its own, open its settings and keep its connection?
// Runs the packaged app with its window held off every display on a converted profile copy (own HOME, runtime
// root, no credentials, dead proxy) and drives the renderer over CDP.
//
//   node scripts/upgrade-profile-check.mjs --install=<win-unpacked> --profile=<converted MIXDOG_HOME copy>
//     --desktop-profile=<converted desktop profile copy> --work=<scratch dir> [--out=result.json]
//
// The app and its core WRITE to the two profile copies: give it copies. Exit 0 only when every area passes.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

import { CdpClient, waitForTarget } from './cdp-client.mjs';

const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const need = (name) => {
  const v = arg(name);
  if (!v) throw new Error(`missing --${name}=`);
  return resolve(v);
};
const install = need('install');
const profile = need('profile');
const desktopProfile = need('desktop-profile');
const work = need('work');
const outPath = arg('out') ? resolve(arg('out')) : resolve(work, 'upgrade-check-result.json');
const readyMs = Number(arg('ready-ms', 240_000));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fwd = (p) => p.replace(/\\/g, '/');
const home = `${fwd(work)}/app-home`;
const runtimeRoot = `${fwd(work)}/app-runtime`;
for (const d of [runtimeRoot, `${home}/AppData/Roaming`, `${home}/AppData/Local`, `${fwd(work)}/app-tmp`])
  mkdirSync(d, { recursive: true });
const port = await new Promise((res) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => res(p));
  });
});
const proxy = 'http://127.0.0.1:9';
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  APPDATA: `${home}/AppData/Roaming`,
  LOCALAPPDATA: `${home}/AppData/Local`,
  TEMP: `${fwd(work)}/app-tmp`,
  TMP: `${fwd(work)}/app-tmp`,
  MIXDOG_HOME: profile,
  MIXDOG_DATA_DIR: `${fwd(profile)}/data`,
  MIXDOG_RUNTIME_ROOT: runtimeRoot,
  MIXDOG_DESKTOP_USER_DATA: desktopProfile,
  MIXDOG_DESKTOP_HIDDEN_WINDOW: '1',
  HTTP_PROXY: proxy,
  HTTPS_PROXY: proxy,
  http_proxy: proxy,
  https_proxy: proxy,
  NO_PROXY: '127.0.0.1,localhost',
  no_proxy: '127.0.0.1,localhost',
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.MIXDOGD_BIN;

// What the switch from 1.4.5 finds in the runtime root: the discovery file of the 1.4.5 daemon that was just ended, naming
// a process that no longer runs. An app that takes it for a core never starts one (the failed switch of 2026-11-13 03:51).
const ended = spawnSync(process.execPath, ['-e', '']).pid;
writeFileSync(
  `${runtimeRoot}/daemon.json`,
  JSON.stringify({
    protocol: 1,
    revision: 6,
    version: '1.4.5',
    pid: ended,
    startedAt: Date.now() - 3_600_000,
    endpoints: { channel: { port: 1, token: 'ended' }, session: { port: 2, token: 'ended' } },
  })
);
const startedAt = new Date().toISOString();
const app = spawn(`${install}/Mixdog.exe`, [`--remote-debugging-port=${port}`], {
  env,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  cwd: install,
});
let appOutput = '';
for (const s of [app.stdout, app.stderr]) s.setEncoding('utf8').on('data', (c) => (appOutput += c));

// Ends only what this run started, by pid: the core its discovery named while it served (an installation path or
// profile is no proof of ownership: another process may use the same ones), then the app with its process tree.
let corePid = null;
function stopEverything() {
  const pids = [...(corePid ? [corePid] : []), ...(app.exitCode === null && app.signalCode === null ? [app.pid] : [])];
  for (const pid of pids)
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}

const exceptions = [];
const consoleErrors = [];
const areas = {};
let screenText = '';
let client = null;
try {
  const wsUrl = await waitForTarget(port, app, { pollMs: 250, timeoutMs: 120_000 });
  client = new CdpClient(wsUrl, { defaultTimeoutMs: 60_000 });
  client.on('Runtime.exceptionThrown', (p) =>
    exceptions.push(p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || 'exception')
  );
  client.on('Runtime.consoleAPICalled', (p) => {
    if (p?.type === 'error')
      consoleErrors.push(
        (p.args || [])
          .map((a) => a.value ?? a.description ?? '')
          .join(' ')
          .slice(0, 600)
      );
  });
  await client.connect();
  await client.request('Runtime.enable');

  const ev = (fn, ...args) =>
    client.evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`, Math.max(90_000, readyMs + 30_000));
  const waitUi = (pollFn, ms) =>
    ev(
      async (src, limit) => {
        const poll = eval(src);
        const end = Date.now() + limit;
        while (Date.now() < end) {
          const v = poll();
          if (v) return true;
          await new Promise((r) => setTimeout(r, 250));
        }
        return false;
      },
      pollFn.toString(),
      ms
    );
  const recovery = () =>
    ev(() => {
      const el = document.querySelector('.desktop-recovery-screen');
      return el ? el.textContent.replace(/\s+/g, ' ').trim().slice(0, 300) : null;
    });

  // The window draws its Settings button, or the error boundary replaces the screen.
  const settled = await waitUi(
    () =>
      document.querySelector('button.sidebar-settings-button') || document.querySelector('.desktop-recovery-screen'),
    readyMs
  );
  await sleep(5000);
  const recovered = settled ? await recovery() : `no Settings button and no recovery screen after ${readyMs} ms`;
  if (recovered) {
    areas.settings = { status: 'error', error: `screen replaced by: ${recovered}` };
  } else {
    // Settings: the dialog opens, finishes loading, shows no error and a non-empty body.
    const s = await ev(async () => {
      const wait = async (f, ms) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          const v = f();
          if (v) return v;
          await new Promise((r) => setTimeout(r, 100));
        }
        return null;
      };
      const open = document.querySelector('button.sidebar-settings-button');
      if (!open) return { error: 'Open settings button not drawn' };
      open.click();
      const dialog = await wait(
        () => document.querySelector('[role="dialog"][aria-labelledby="mixdog-settings-title"]'),
        20_000
      );
      if (!dialog)
        return {
          error: document.querySelector('.desktop-recovery-screen')
            ? 'screen replaced by the error boundary'
            : 'settings dialog did not open',
        };
      if (!(await wait(() => !document.querySelector('.settings-loading'), 45_000)))
        return { error: 'settings still loading after 45000 ms' };
      await new Promise((r) => setTimeout(r, 1500));
      // An error the pane shows (ErrorNotice), with its details opened: the reason is what a failure report needs.
      const err = dialog.querySelector('.error-notice, [role="alert"]');
      err?.querySelector('.error-notice-actions button[aria-expanded="false"]')?.click();
      if (err) await new Promise((r) => setTimeout(r, 300));
      return {
        error: err ? err.textContent.replace(/\s+/g, ' ').trim().slice(0, 900) : null,
        bodyLength: (dialog.querySelector('.mixdog-settings__body')?.textContent || '').trim().length,
        categories: dialog.querySelectorAll('.mixdog-settings__rail button').length,
      };
    });
    // The profile copy carries no credentials, so the model list of a signed-in provider answers "not signed in" . That one reason is the copy's, and is
    // reported; any other error the pane shows fails.
    const unsigned = /Failed to init "[^"]+": not signed in/.test(s.error || '');
    areas.settings =
      (s.error && !unsigned) || !s.bodyLength
        ? { status: 'error', error: s.error || 'empty settings body' }
        : {
            status: 'pass',
            drawn: { categories: s.categories, bodyLength: s.bodyLength },
            ...(unsigned ? { noCredentialsInCopy: s.error } : {}),
          };
  }
  // The app's own core, serving: read while everything still runs.
  try {
    const record = JSON.parse(readFileSync(`${runtimeRoot}/daemon.json`, 'utf8'));
    // One test for both the verdict and the cleanup: a serving record without a usable pid is not the app's own core.
    const serving =
      record.core?.state === 'serving' && Number.isInteger(record.pid) && record.pid > 0 && record.pid !== ended;
    if (serving) corePid = record.pid;
    areas.core = serving
      ? { status: 'pass', drawn: record.core.state }
      : {
          status: 'fail',
          error: `the runtime root's discovery is ${record.core ? `a core that is ${record.core.state}` : "still the ended 1.4.5 daemon's"}`,
        };
  } catch (e) {
    areas.core = { status: 'fail', error: `no discovery file: ${e.message}` };
  }
  // What the window shows when it is done, for whoever reads a failure.
  screenText = await ev(() => document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 600));
  const shot = await client.request('Page.captureScreenshot', { format: 'png' });
  writeFileSync(resolve(work, 'upgrade-check-final.png'), Buffer.from(shot.data, 'base64'));
} catch (e) {
  areas.run = { status: 'error', error: String(e?.stack ?? e).slice(0, 600) };
} finally {
  try {
    client?.close();
  } catch {
    /* socket already closed */
  }
  await sleep(500);
  stopEverything();
}

// The connection is judged from this run's diagnostics: a log that is absent, unreadable, malformed or holds no entry
// of this run is no evidence of a kept connection, and fails.
let diagnostics = [];
let diagnosticsError = null;
try {
  const thisRun = readFileSync(`${desktopProfile}/logs/desktop-diagnostics.jsonl`, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    // A line without a valid timestamp is no evidence of this run; instants are compared, not their spellings.
    .filter((e) => typeof e?.at === 'string' && Date.parse(e.at) >= Date.parse(startedAt));
  if (!thisRun.length) diagnosticsError = 'the diagnostics log holds no entry of this run';
  diagnostics = thisRun.filter((e) => /error|fail|exception|connectionLost/i.test(JSON.stringify(e)));
} catch (e) {
  diagnosticsError = `the diagnostics log of this run is absent or unreadable: ${e.message}`;
}
// The core connection: a screen drawn from what was cached before the connection dropped is not a working app.
const lost = diagnostics.filter((e) => /connectionLost|request-failed/.test(JSON.stringify(e)));
areas.connection = diagnosticsError
  ? { status: 'fail', error: diagnosticsError }
  : lost.length
    ? {
        status: 'fail',
        error: `${lost.length} diagnostics of this run report a lost connection or a failed read`,
        drawn: lost
          .slice(0, 3)
          .map((e) => `${e.event}${e.message ? `: ${e.message}` : ''}${e.stage ? ` (${e.stage})` : ''}`),
      }
    : { status: 'pass', drawn: 0 };
diagnostics = diagnostics.slice(-10);
const result = {
  passed: ['settings', 'connection', 'core'].every((n) => areas[n]?.status === 'pass') && !areas.run,
  areas,
  screenText,
  rendererExceptions: exceptions.slice(0, 5),
  consoleErrors: consoleErrors.slice(0, 5),
  diagnosticsErrors: diagnostics,
  // What the app's own process said of a failure (a rejected request names its error there and nowhere else).
  appErrors: [
    ...new Set(
      appOutput
        .split(/\r?\n/)
        .filter((line) => /error|fail|reject/i.test(line))
        .map((line) => line.slice(0, 500))
    ),
  ].slice(0, 30),
};
writeFileSync(outPath, JSON.stringify(result, null, 1));
writeFileSync(resolve(work, 'app-output.log'), appOutput);
for (const [name, a] of Object.entries(areas)) {
  console.log(`${a.status.toUpperCase().padEnd(5)} ${name}: ${a.error ?? ''} drawn=${JSON.stringify(a.drawn ?? null)}`);
}
console.log(result.passed ? 'SCREEN CHECK PASSED' : 'SCREEN CHECK FAILED');
process.exit(result.passed ? 0 : 1);
