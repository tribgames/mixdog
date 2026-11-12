// K1 screen check: does the built desktop DRAW a converted profile served by a real mixdogd?
// Runs the packaged app with its window held off every display on a converted profile copy (own HOME, runtime
// root, no credentials, dead proxy), drives the renderer over CDP and, per screen area, records drawn or error
// with the rows drawn next to Node's rows for the same profile (k1-screen-baseline.mjs output).
//
//   node scripts/k1-screen-check.mjs --install=<win-unpacked> --profile=<converted MIXDOG_HOME copy>
//     --desktop-profile=<converted desktop profile copy> --baseline=<baseline.json> --work=<scratch dir> [--out=result.json]
//
// The app and its core WRITE to the two profile copies: give it copies. Exit 0 only when every area passes.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

import { CdpClient, waitForTarget } from './cdp-client.mjs';

const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const need = (name) => {
  const v = arg(name);
  if (!v) throw new Error(`missing --${name}=`);
  return resolve(v);
};
const install = need('install');
const profile = need('profile');
const desktopProfile = need('desktop-profile');
const work = need('work');
const baseline = JSON.parse(readFileSync(need('baseline'), 'utf8'));
const outPath = arg('out') ? resolve(arg('out')) : resolve(work, 'screen-check-result.json');
const readyMs = Number(arg('ready-ms', 240_000));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fwd = (p) => p.replace(/\\/g, '/');
const home = `${fwd(work)}/app-home`;
const runtimeRoot = `${fwd(work)}/app-runtime`;
for (const d of [runtimeRoot, `${home}/AppData/Roaming`, `${home}/AppData/Local`, `${fwd(work)}/app-tmp`]) mkdirSync(d, { recursive: true });
const port = await new Promise((res) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => res(p));
  });
});
const proxy = 'http://127.0.0.1:9';
const env = {
  ...process.env,
  HOME: home, USERPROFILE: home, APPDATA: `${home}/AppData/Roaming`, LOCALAPPDATA: `${home}/AppData/Local`,
  TEMP: `${fwd(work)}/app-tmp`, TMP: `${fwd(work)}/app-tmp`,
  MIXDOG_HOME: profile, MIXDOG_DATA_DIR: `${fwd(profile)}/data`, MIXDOG_RUNTIME_ROOT: runtimeRoot,
  MIXDOG_DESKTOP_USER_DATA: desktopProfile, MIXDOG_DESKTOP_HIDDEN_WINDOW: '1',
  HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.MIXDOGD_BIN;

// What the switch from 1.4.5 finds in the runtime root: the discovery file of the 1.4.5 daemon that was just ended, naming
// a process that no longer runs. An app that takes it for a core never starts one (the failed switch of 2026-11-13 03:51).
const ended = spawnSync(process.execPath, ['-e', '']).pid;
writeFileSync(`${runtimeRoot}/daemon.json`, JSON.stringify({ protocol: 1, revision: 6, version: '1.4.5', pid: ended, startedAt: Date.now() - 3_600_000, endpoints: { channel: { port: 1, token: 'ended' }, session: { port: 2, token: 'ended' } } }));
const startedAt = new Date().toISOString();
const app = spawn(`${install}/Mixdog.exe`, [`--remote-debugging-port=${port}`], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: install });
let appOutput = '';
for (const s of [app.stdout, app.stderr]) s.setEncoding('utf8').on('data', (c) => (appOutput += c));

// Every process of this run: the app tree, and the core it started under our runtime root / profile copies.
function ownPids() {
  const marks = [install, runtimeRoot, desktopProfile, profile].map((p) => fwd(p).toLowerCase());
  const script = `Get-CimInstance Win32_Process | ForEach-Object { $e=([string]$_.ExecutablePath).Replace('\\','/').ToLower(); $c=([string]$_.CommandLine).Replace('\\','/').ToLower(); "$($_.ProcessId)|$e|$c" }`;
  return execFileSync('powershell', ['-NoProfile', '-Command', script], { windowsHide: true, maxBuffer: 64 << 20 })
    .toString().split(/\r?\n/).filter(Boolean)
    .map((l) => l.split('|'))
    .filter(([pid, exe, ...cmd]) => Number(pid) !== process.pid && marks.some((m) => exe.startsWith(m) || cmd.join('|').includes(m)))
    .map(([pid]) => Number(pid));
}
function stopEverything() {
  for (const pid of ownPids()) {
    try { process.kill(pid); } catch { /* already gone */ }
  }
}

const exceptions = [];
const consoleErrors = [];
const areas = {};
let screenText = '';
let client = null;
try {
  const wsUrl = await waitForTarget(port, app, { pollMs: 250, timeoutMs: 120_000 });
  client = new CdpClient(wsUrl, { defaultTimeoutMs: 60_000 });
  client.on('Runtime.exceptionThrown', (p) => exceptions.push(p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || 'exception'));
  client.on('Runtime.consoleAPICalled', (p) => {
    if (p?.type === 'error') consoleErrors.push((p.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 600));
  });
  await client.connect();
  await client.request('Runtime.enable');

  const ev = (fn, ...args) => client.evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`, Math.max(90_000, readyMs + 30_000));
  const waitUi = (pollFn, ms) => ev(async (src, limit) => {
    const poll = eval(src);
    const end = Date.now() + limit;
    while (Date.now() < end) {
      const v = poll();
      if (v) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }, pollFn.toString(), ms);
  const recovery = () => ev(() => {
    const el = document.querySelector('.desktop-recovery-screen');
    return el ? el.textContent.replace(/\s+/g, ' ').trim().slice(0, 300) : null;
  });

  // Session list: the sidebar draws session rows, or the error boundary replaces the screen.
  const settled = await waitUi(() => document.querySelector('.session-row[data-session-id]') || document.querySelector('.desktop-recovery-screen'), readyMs);
  await sleep(5000);
  const recovered = settled ? await recovery() : `no session row and no recovery screen after ${readyMs} ms`;
  const nodeIds = new Set(baseline.sessions.map((s) => s.id));
  if (recovered) {
    for (const name of ['sessionList', 'projectList', 'sessionTranscript', 'settings']) {
      areas[name] = { status: 'error', error: `screen replaced by: ${recovered}`, node: {} };
    }
  } else {
    const drawn = await ev(() => Array.from(document.querySelectorAll('.session-row[data-session-id]')).map((r) => r.getAttribute('data-session-id')));
    const offNode = drawn.filter((id) => !nodeIds.has(id));
    // Node's sidebar draws no agent's worker session: one drawn here is a row the screen should not show. A drawn row Node
    // does not list at all (the two copies are snapshots of a live profile taken at different times) is reported, not judged.
    const agentIds = new Set(baseline.sessions.filter((s) => s.agent).map((s) => s.id));
    const agentRows = drawn.filter((id) => agentIds.has(id));
    // "Show all sessions" is the profile's own choice (session-sidebar-state.ts): with it on, Node's sidebar lists them too.
    const showAgents = await ev(() => localStorage.getItem('mixdog:session-sidebar-show-agents'));
    const showsAgents = showAgents === 'true' || showAgents === '1';
    areas.sessionList = {
      status: drawn.length > 0 && (showsAgents || agentRows.length === 0) ? 'pass' : 'fail',
      drawn: drawn.length, node: { sessions: baseline.sessions.length, sidebar: baseline.sessions.length - agentIds.size },
      showAgents, agentRowsDrawn: agentRows.length, agentRows: agentRows.slice(0, 5), notInNodeCount: offNode.length, notInNode: offNode.slice(0, 5),
    };

    // Project list: the project switcher against Node's registered projects.
    const projects = await ev(async () => {
      const wait = async (f, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = f(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };
      // By class, not by label: the labels are the profile's language.
      const ta = document.querySelector('.composer-text-field textarea');
      if (!ta) return { error: 'composer not drawn (main area is still the boot spinner)' };
      ta.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, '/project');
      ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '/project' }));
      await new Promise((r) => setTimeout(r, 150));
      const send = await wait(() => { const b = document.querySelector('button.send-button:not(.stop)'); return b && !b.disabled ? b : null; }, 10_000);
      if (!send) return { error: 'send button never enabled' };
      send.closest('form').requestSubmit(send);
      // `/project` turns the sidebar to its Projects pane: one row per registered Project.
      // The pane's first list is the one fixed "Common Memory" row (`projects-common-instructions`), not a Project.
      const rows = '.projects-pane .projects-list:not(.projects-common-instructions) .projects-row';
      const first = await wait(() => document.querySelector(rows), 20_000);
      if (!first) return { error: 'no project row drawn in the Projects pane' };
      await new Promise((r) => setTimeout(r, 1500));
      const drawn = Array.from(document.querySelectorAll(rows));
      return { text: drawn.map((f) => f.textContent.replace(/\s+/g, ' ').trim()).join(' | '), rows: drawn.length };
    });
    if (projects.error) {
      areas.projectList = { status: 'error', error: projects.error, node: { projects: baseline.projects.length } };
    } else {
      const missing = baseline.projects.filter((p) => !projects.text.includes(p.name)).map((p) => p.name);
      areas.projectList = {
        status: projects.rows === baseline.projects.length && missing.length === 0 ? 'pass' : 'fail',
        drawn: projects.rows, node: { projects: baseline.projects.length }, missingFromScreen: missing, rows: projects.text,
      };
    }

    // A session opened to its transcript: the first drawn row Node also lists with messages.
    const target = drawn.map((id) => baseline.sessions.find((s) => s.id === id)).find((s) => s && s.messageCount > 0);
    if (!target) {
      areas.sessionTranscript = { status: 'error', error: 'no drawn session row is one Node lists with messages', node: {} };
    } else {
      const t = await ev(async (id) => {
        const row = document.querySelector(`.session-row[data-session-id="${id}"]`);
        if (!row) return { error: 'row gone' };
        row.click();
        const end = Date.now() + 60_000;
        while (Date.now() < end) {
          if (document.querySelector('.desktop-recovery-screen')) return { error: 'screen replaced by the error boundary' };
          const n = document.querySelectorAll('.transcript article.message, .transcript-virtual-row').length;
          if (n > 0) return { rows: n };
          await new Promise((r) => setTimeout(r, 250));
        }
        return { error: 'no transcript row drawn in 60 s' };
      }, target.id);
      areas.sessionTranscript = t.error
        ? { status: 'error', error: t.error, session: target.id, node: { messageCount: target.messageCount } }
        : { status: 'pass', drawn: t.rows, session: target.id, node: { messageCount: target.messageCount } };
    }

    // Settings: the dialog opens, finishes loading, shows no error and a non-empty body.
    const s = await ev(async () => {
      const wait = async (f, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = f(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };
      const open = document.querySelector('button.sidebar-settings-button');
      if (!open) return { error: 'Open settings button not drawn' };
      open.click();
      const dialog = await wait(() => document.querySelector('[role="dialog"][aria-labelledby="mixdog-settings-title"]'), 20_000);
      if (!dialog) return { error: document.querySelector('.desktop-recovery-screen') ? 'screen replaced by the error boundary' : 'settings dialog did not open' };
      await wait(() => !document.querySelector('.settings-loading'), 45_000);
      await new Promise((r) => setTimeout(r, 1500));
      // An error the pane shows (ErrorNotice), with its details opened: the reason is what a failure report needs.
      const err = dialog.querySelector('.error-notice, [role="alert"]');
      err?.querySelector('.error-notice-actions button[aria-expanded="false"]')?.click();
      if (err) await new Promise((r) => setTimeout(r, 300));
      return { error: err ? err.textContent.replace(/\s+/g, ' ').trim().slice(0, 900) : null, bodyLength: (dialog.querySelector('.mixdog-settings__body')?.textContent || '').trim().length, categories: dialog.querySelectorAll('.mixdog-settings__rail button').length };
    });
    // The profile copy carries no credentials, so the model list of a signed-in provider answers "not signed in" (Node words it
    // the same: registry.mjs "[provider] Failed to init", antigravity-oauth-tokens.mjs). That one reason is the copy's, and is
    // reported; any other error the pane shows fails.
    const unsigned = /Failed to init "[^"]+": not signed in/.test(s.error || '');
    areas.settings = (s.error && !unsigned) || !s.bodyLength
      ? { status: 'error', error: s.error || 'empty settings body', node: {} }
      : { status: 'pass', drawn: { categories: s.categories, bodyLength: s.bodyLength }, node: {}, ...(unsigned ? { noCredentialsInCopy: s.error } : {}) };
  }
  // The app's own core, serving: read while everything still runs.
  try {
    const record = JSON.parse(readFileSync(`${runtimeRoot}/daemon.json`, 'utf8'));
    areas.core = record.core?.state === 'serving' && record.pid !== ended
      ? { status: 'pass', drawn: record.core.state, node: {} }
      : { status: 'fail', error: `the runtime root's discovery is ${record.core ? `a core that is ${record.core.state}` : 'still the ended 1.4.5 daemon\'s'}`, node: {} };
  } catch (e) {
    areas.core = { status: 'fail', error: `no discovery file: ${e.message}`, node: {} };
  }
  // What the window shows when it is done, for whoever reads a failure.
  screenText = await ev(() => document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 600));
  const shot = await client.request('Page.captureScreenshot', { format: 'png' });
  writeFileSync(resolve(work, 'screen-check-final.png'), Buffer.from(shot.data, 'base64'));
} catch (e) {
  areas.run = { status: 'error', error: String(e?.stack ?? e).slice(0, 600) };
} finally {
  try { client?.close(); } catch { /* socket already closed */ }
  await sleep(500);
  stopEverything();
}

let diagnostics = [];
try {
  diagnostics = readFileSync(`${desktopProfile}/logs/desktop-diagnostics.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((e) => String(e.at) >= startedAt && /error|fail|exception|connectionLost/i.test(JSON.stringify(e)));
} catch { /* no diagnostics file */ }
// The core connection: a screen drawn from what was cached before the connection dropped is not a working app.
const lost = diagnostics.filter((e) => /connectionLost|request-failed/.test(JSON.stringify(e)));
areas.connection = lost.length
  ? { status: 'fail', error: `${lost.length} diagnostics of this run report a lost connection or a failed read`, drawn: lost.slice(0, 3).map((e) => `${e.event}${e.message ? `: ${e.message}` : ''}${e.stage ? ` (${e.stage})` : ''}`), node: {} }
  : { status: 'pass', drawn: 0, node: {} };
diagnostics = diagnostics.slice(-10);
const result = {
  passed: ['sessionList', 'projectList', 'sessionTranscript', 'settings', 'connection', 'core'].every((n) => areas[n]?.status === 'pass') && !areas.run,
  areas, screenText, rendererExceptions: exceptions.slice(0, 5), consoleErrors: consoleErrors.slice(0, 5), diagnosticsErrors: diagnostics,
};
writeFileSync(outPath, JSON.stringify(result, null, 1));
for (const [name, a] of Object.entries(areas)) {
  console.log(`${a.status.toUpperCase().padEnd(5)} ${name}: ${a.error ?? ''} drawn=${JSON.stringify(a.drawn ?? null)} node=${JSON.stringify(a.node)}`);
}
console.log(result.passed ? 'SCREEN CHECK PASSED' : 'SCREEN CHECK FAILED');
process.exit(result.passed ? 0 : 1);
