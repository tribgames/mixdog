// Real-app prompt submit shift probe (diagnosis tooling).
//
//   node apps/desktop/scripts/submit-shift-probe.mjs [--project=<path>] [--history=5] [--port=9351]
//
// Launches the built desktop app (apps/desktop/out) in an isolated profile with
// CDP, submits prompts through the REAL composer (CDP keyboard input), and
// samples every animation frame: viewport scroll state, on-screen position of
// each visible transcript row, composer-region children heights, header
// height, plus every programmatic scrollTop/scrollTo write (with caller
// stack) and every layout-shift entry (with sources). It reports frames in
// which an already-visible row moved relative to its final position — the
// visible up/down bounce on submit — and which element changed in that frame.
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argumentsList = process.argv.slice(2);
const valueFor = (prefix) => argumentsList
  .find((argument) => argument.startsWith(`${prefix}=`))
  ?.slice(prefix.length + 1);
const projectPath = resolve(valueFor('--project') || join(desktopDir, '..', '..'));
const historyTurns = Math.max(0, Number(valueFor('--history') || 5));
const port = Number(valueFor('--port') || 9351);
// A fake OpenAI-compatible server (fake-openai-compat-server.mjs) makes the
// isolated profile run REAL turns: reasoning band, streaming tail, settle.
const fakeModelPort = Number(valueFor('--fake-model-port') || 0);
const recordMs = Number(valueFor('--record') || (fakeModelPort ? 9_000 : 3_000));
const keepProfile = argumentsList.includes('--keep-profile');
const electron = join(desktopDir, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron');
const profilePath = join(desktopDir, 'artifacts', 'submit-shift-profile');

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

class Cdp {
  constructor(url) { this.socket = new WebSocket(url); this.nextId = 1; this.pending = new Map(); }
  async connect() {
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id || !this.pending.has(message.id)) return;
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
    await new Promise((done, fail) => {
      this.socket.addEventListener('open', done, { once: true });
      this.socket.addEventListener('error', () => fail(new Error('CDP websocket failed.')), { once: true });
    });
  }
  request(method, params = {}) {
    return new Promise((done, fail) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve: done, reject: fail });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.request('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result?.value;
  }
  close() { this.socket.close(); }
}

async function waitForTarget(child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited with ${child.exitCode}.`);
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const target = targets.find((candidate) => candidate.type === 'page'
        && candidate.url?.includes('/out/renderer/index.html'));
      if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
    } catch { /* not listening yet */ }
    await sleep(50);
  }
  throw new Error(`CDP target did not appear on port ${port}.`);
}

async function evaluateStable(client, expression, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try { return await client.evaluate(expression); } catch (error) {
      lastError = error;
      if (!/Execution context was destroyed|Cannot find context|localStorage/i.test(String(error?.message))) throw error;
      await sleep(100);
    }
  }
  throw lastError || new Error('Renderer did not stabilize.');
}

async function stopApp(client, child) {
  try { await client.evaluate('window.mixdogDesktop?.quit?.()'); } catch { /* fallback below */ }
  client.close();
  await Promise.race([new Promise((done) => child.once('exit', done)), sleep(4_000)]);
  if (child.exitCode === null) child.kill();
}

// Installed once: layout-shift observer, transcript scroll-write attribution,
// and a rAF sampler that starts on demand.
const INSTALL = `(() => {
  if (!window.__probe) {
    const shifts = [];
    const describe = (node) => {
      let current = node; const parts = [];
      for (let depth = 0; current && current.nodeType === 1 && depth < 3; depth += 1, current = current.parentElement) {
        const classes = typeof current.className === 'string'
          ? current.className.trim().split(/\\s+/).filter(Boolean).slice(0, 3).join('.') : '';
        parts.push(current.tagName.toLowerCase() + (classes ? '.' + classes : ''));
      }
      return parts.join(' < ');
    };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        shifts.push({ t: Math.round(entry.startTime), value: Number(entry.value.toFixed(5)),
          recent: entry.hadRecentInput === true,
          sources: (entry.sources || []).slice(0, 5).map((source) => ({ node: describe(source.node),
            from: Math.round(source.previousRect?.y ?? 0), to: Math.round(source.currentRect?.y ?? 0),
            fromH: Math.round(source.previousRect?.height ?? 0), toH: Math.round(source.currentRect?.height ?? 0) })) });
      }
    }).observe({ type: 'layout-shift', buffered: false });
    const writes = [];
    const stackOf = () => (new Error().stack || '').split('\\n').slice(3, 8)
      .map((line) => line.trim().replace(/^at /, '').replace(/https?:\\/\\/[^/]+\\//g, '').replace(/file:\\/\\/\\/[^ ]*\\/out\\//g, '')).join(' | ');
    const proto = Element.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'scrollTop');
    Object.defineProperty(proto, 'scrollTop', { configurable: true,
      get() { return descriptor.get.call(this); },
      set(value) {
        if (this.classList && this.classList.contains('transcript')) {
          writes.push({ t: Math.round(performance.now()), kind: 'scrollTop=', from: Math.round(descriptor.get.call(this)),
            to: Math.round(value), max: Math.round(this.scrollHeight - this.clientHeight), stack: stackOf() });
        }
        descriptor.set.call(this, value);
      } });
    const originalScrollTo = proto.scrollTo;
    proto.scrollTo = function scrollToProbe(...args) {
      const top = args.length === 1 && typeof args[0] === 'object' ? args[0]?.top : args[1];
      if (typeof top === 'number' && this.classList && this.classList.contains('transcript')) {
        writes.push({ t: Math.round(performance.now()), kind: 'scrollTo', from: Math.round(descriptor.get.call(this)),
          to: Math.round(top), max: Math.round(this.scrollHeight - this.clientHeight), stack: stackOf() });
      }
      return originalScrollTo.apply(this, args);
    };
    const heightOf = (selector, root = document) => {
      const node = root.querySelector(selector);
      return node ? Math.round(node.getBoundingClientRect().height) : -1;
    };
    const sample = () => {
      const probe = window.__probe;
      if (!probe.frames) return;
      let view = null;
      for (const element of document.querySelectorAll('.transcript')) {
        const rect = element.getBoundingClientRect();
        if (rect.width < 100 || rect.height < 50) continue;
        view = { element, rect };
      }
      const surface = view ? (view.element.closest('.pane-chat-surface') || document) : document;
      const composer = surface.querySelector('.composer-region');
      const header = surface.querySelector('header');
      const textarea = surface.querySelector('.composer textarea');
      const rows = view ? [...view.element.querySelectorAll('.transcript-virtual-row')].map((row) => {
        const box = row.getBoundingClientRect();
        const article = row.querySelector('article');
        const content = row.firstElementChild;
        // Content signature: what the row is made of at this frame (settled
        // vs live article, Markdown body present, text length, footer).
        const sig = (article ? article.className.replace(/\\s+/g, '.') : (content?.firstElementChild?.className || '').split(/\\s+/)[0])
          + '|t' + (row.textContent || '').length
          + (row.querySelector('.markdown-body, [data-markdown-body], .message-body') ? '|md' : '')
          + (row.querySelector('footer') ? '|ft' : '')
          + (row.querySelector('.live-activity') ? '|live' : '');
        return { key: row.dataset.timelineKey || row.dataset.index || '', top: Math.round(box.top - view.rect.top),
          h: Math.round(box.height), ch: Math.round(content?.getBoundingClientRect().height || 0), sig,
          visible: box.bottom > view.rect.top && box.top < view.rect.bottom };
      }).filter((row) => row.visible) : [];
      probe.frames.push({
        t: Math.round(performance.now()),
        hidden: view ? getComputedStyle(view.element).visibility === 'hidden' : true,
        top: view ? Math.round(view.element.scrollTop) : -1,
        height: view ? Math.round(view.element.scrollHeight) : -1,
        client: view ? Math.round(view.element.clientHeight) : -1,
        viewTop: view ? Math.round(view.rect.top) : -1,
        viewBottom: view ? Math.round(view.rect.bottom) : -1,
        headerH: header ? Math.round(header.getBoundingClientRect().height) : -1,
        composerH: composer ? Math.round(composer.getBoundingClientRect().height) : -1,
        contextBarH: composer ? heightOf('.composer-context-bar', composer) : -1,
        progressH: composer ? heightOf('.runtime-progress', composer) : -1,
        goalH: composer ? heightOf('.session-goal-island', composer) : -1,
        reviewH: composer ? heightOf('.turn-review-slot', composer) : -1,
        approvalH: composer ? heightOf('.composer-approval-row', composer) : -1,
        textareaH: textarea ? Math.round(textarea.getBoundingClientRect().height) : -1,
        composerBoxH: composer ? heightOf('.composer', composer) : -1,
        composerKids: composer ? [...composer.children].map((node) => (typeof node.className === 'string'
          ? node.className.trim().split(/\\s+/)[0] : node.tagName.toLowerCase()) + ':' + Math.round(node.getBoundingClientRect().height)).join(',') : '',
        rows,
      });
      if (probe.frames.length < 2400) requestAnimationFrame(sample);
    };
    window.__probe = { shifts, writes, frames: null,
      start() { shifts.length = 0; writes.length = 0; this.frames = []; requestAnimationFrame(sample); },
      stop() { const frames = this.frames || []; this.frames = null;
        return { frames, writes: writes.splice(0), shifts: shifts.splice(0) }; } };
  }
  return true;
})()`;

const STATE = `(() => {
  const textarea = document.querySelector('.composer textarea');
  const view = [...document.querySelectorAll('.transcript')].find((el) => el.getBoundingClientRect().height > 50);
  return { composer: Boolean(textarea), disabled: Boolean(textarea?.disabled),
    spinner: Boolean(document.querySelector('.live-work-spinner')),
    live: Boolean(document.querySelector('.live-activity, [data-streaming-tail="true"]')),
    rows: view ? view.querySelectorAll('.transcript-virtual-row').length : 0,
    userRows: document.querySelectorAll('[data-tag="UserMessage"]').length,
    contextBar: Boolean(document.querySelector('.composer-context-bar')),
    title: document.querySelector('header h1')?.textContent?.trim().slice(0, 40) || '',
    href: location.hash || '' };
})()`;

async function waitFor(client, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    state = await evaluateStable(client, STATE);
    if (predicate(state)) return state;
    await sleep(100);
  }
  throw new Error(`${label} timed out; last state ${JSON.stringify(state)}`);
}

async function typeAndSubmit(client, text, { record }) {
  await client.evaluate(`(() => { const t = document.querySelector('.composer textarea'); t.focus({ preventScroll: true }); return true; })()`);
  await client.request('Input.insertText', { text });
  await sleep(150);
  let typed = await client.evaluate(`(() => { const t = document.querySelector('.composer textarea');
    return { value: t?.value.length || 0, active: document.activeElement?.tagName || '', h: Math.round(t?.getBoundingClientRect().height || 0) }; })()`);
  if (!typed.value) {
    // CDP text insertion needs a focused, foreground page; fall back to the
    // native value setter + input event the isolated probe uses.
    await client.evaluate(`(() => { const t = document.querySelector('.composer textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, ${JSON.stringify(text)});
      t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(150);
    typed = await client.evaluate(`(() => { const t = document.querySelector('.composer textarea');
      return { value: t?.value.length || 0, active: document.activeElement?.tagName || '', h: Math.round(t?.getBoundingClientRect().height || 0), fallback: true }; })()`);
  }
  console.log('typed', JSON.stringify(typed));
  if (record) await client.evaluate('window.__probe.start(), true');
  await sleep(48);
  await client.request('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter',
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await client.request('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter',
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(400);
  const after = await client.evaluate(`(() => { const t = document.querySelector('.composer textarea');
    return { value: t?.value.length || 0, notice: [...document.querySelectorAll('[role="alert"], .composer-notice, .attachment-error, .inline-error')]
      .map((n) => n.textContent?.trim().slice(0, 80)).filter(Boolean).join(' | ') }; })()`);
  if (after.value === typed.value) {
    // Enter through CDP did not clear the draft: use the synthetic keydown
    // the real keyboard hook also handles.
    await client.evaluate(`(() => { const t = document.querySelector('.composer textarea');
      t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
    await sleep(400);
    after.synthetic = true;
    after.valueAfterSynthetic = await client.evaluate(`document.querySelector('.composer textarea')?.value.length || 0`);
  }
  console.log('submitted', JSON.stringify(after));
}

async function settleTurn(client, label) {
  // Wait for the turn's live band to leave the transcript (fake model: a few
  // seconds; no provider: an immediate error row), then a quiet beat.
  await sleep(800);
  await waitFor(client, (state) => state.composer && !state.disabled && !state.spinner && !state.live, 40_000, `${label} settle`);
  await sleep(1_200);
}

// Row keys are `<sessionKey>:<kind>:<id>`; keep the kind and the id tail.
const shortKey = (key) => {
  const parts = key.split(':');
  const tail = parts.slice(1);
  if (!tail.length) return key.slice(-8);
  const kind = tail[0];
  const id = tail.slice(1).join(':');
  return id ? `${kind}:${id.slice(-6)}` : kind.slice(-10);
};

function report(name, capture) {
  const frames = capture.frames;
  const base = frames[0]?.t || 0;
  const final = frames.at(-1);
  const finalTop = new Map((final?.rows || []).map((row) => [row.key, row.top]));
  console.log(`\n=== ${name}: frames=${frames.length} writes=${capture.writes.length} shifts=${capture.shifts.length}`);
  console.log('ms\ttop\tmax\tclient\tviewBot\tcompH\tctx\tprog\tgoal\trev\tta\tbox\tfirst..last\tpreexisting rows vs final (n:min..max)');
  let previous = null;
  for (const frame of frames) {
    const drifts = frame.rows
      .filter((row) => finalTop.has(row.key))
      .map((row) => row.top - finalTop.get(row.key));
    const movedText = drifts.length
      ? `${drifts.length}:${Math.min(...drifts)}..${Math.max(...drifts)}` : '-';
    const summary = [frame.top, frame.height - frame.client, frame.client, frame.viewBottom,
      frame.composerH, frame.contextBarH, frame.progressH, frame.goalH, frame.reviewH, frame.textareaH, frame.composerBoxH].join('\t');
    const rowsText = frame.rows.length
      ? `${shortKey(frame.rows[0].key)}@${frame.rows[0].top} | ` + frame.rows.slice(-3)
        .map((row) => `${shortKey(row.key)}@${row.top}+${row.h}${row.ch !== row.h ? `(c${row.ch})` : ''}[${row.sig}]`).join(' ')
      : '(none)';
    const line = `${summary}\t${rowsText}\t${movedText}`;
    if (previous !== line) console.log(`${frame.t - base}${frame.hidden ? 'H' : ''}\t${line}`);
    previous = line;
  }
  console.log('--- scroll writes ---');
  for (const write of capture.writes) console.log(`${write.t - base}\t${write.kind}\t${write.from} -> ${write.to} (max ${write.max})\t${write.stack}`);
  console.log('--- layout shifts ---');
  for (const shift of capture.shifts) {
    console.log(`${shift.t - base}\tvalue=${shift.value}${shift.recent ? ' (recent-input)' : ''}`);
    for (const source of shift.sources) console.log(`\t  y ${source.from} -> ${source.to}  h ${source.fromH} -> ${source.toH}  ${source.node}`);
  }
}

await rm(profilePath, { recursive: true, force: true }).catch(() => undefined);
await Promise.all(['runtime', 'data', 'home'].map((d) => mkdir(join(profilePath, d), { recursive: true })));
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('MIXDOG_') || key.startsWith('ELECTRON_')) delete env[key];
Object.assign(env, {
  MIXDOG_DESKTOP_USER_DATA: profilePath,
  MIXDOG_RUNTIME_ROOT: join(profilePath, 'runtime'),
  MIXDOG_DATA_DIR: join(profilePath, 'data'),
  MIXDOG_HOME: join(profilePath, 'home'),
  MIXDOG_BOOT_SCENARIO: 'submit-shift-probe',
});
if (fakeModelPort) {
  const { writeFile } = await import('node:fs/promises');
  // deepseek preset: baseURL is user-overridable and reasoning_content deltas
  // reach the thinking band. The key comes from the environment only.
  await writeFile(join(profilePath, 'data', 'mixdog-config.json'), JSON.stringify({
    agent: {
      providers: { deepseek: { enabled: true, baseURL: `http://127.0.0.1:${fakeModelPort}/v1` } },
      presets: [{ id: 'fake-turn', provider: 'deepseek', model: 'deepseek-v4-pro' }],
      default: 'fake-turn',
    },
  }, null, 2));
  env.DEEPSEEK_API_KEY = 'fake-probe-key';
}
const child = spawn(electron, [desktopDir, `--remote-debugging-port=${port}`, '--window-size=1100,720'], {
  cwd: desktopDir, env, stdio: 'ignore', windowsHide: false,
});
const client = new Cdp(await waitForTarget(child));
await client.connect();
try {
  await evaluateStable(client, `(async () => {
    const deadline = performance.now() + 15000;
    while (!window.__mixdogStartupSettled && performance.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    await window.mixdogDesktop.addProject(${JSON.stringify(projectPath)});
    await window.mixdogDesktop.invokeCapability({ capability: 'skipOnboarding', args: [] }).catch(() => undefined);
    return true;
  })()`, 30_000);
  await sleep(1_500);
  await evaluateStable(client, INSTALL);
  const initial = await waitFor(client, (state) => state.composer && !state.disabled, 20_000, 'composer mount');
  console.log('initial', JSON.stringify(initial));

  // Phase A: first submit from the New task draft (context bar + header swap).
  await typeAndSubmit(client, 'Probe first prompt\nsecond line\nthird line', { record: true });
  await sleep(recordMs);
  const captures = {};
  const first = await client.evaluate('window.__probe.stop()');
  captures['draft-first-submit'] = first;
  report('draft-first-submit', first);
  console.log('after-first', JSON.stringify(await evaluateStable(client, STATE)));
  if (argumentsList.includes('--second-draft')) {
    // Same launch, a SECOND new task: separates "first turn after launch"
    // (cold renderer/runtime paths) from "first turn of every session".
    await settleTurn(client, 'first');
    await client.evaluate(`(() => {
      const link = document.querySelector('.session-new-task') || document.querySelector('button[aria-label="New task"]');
      if (link instanceof HTMLElement) { link.click(); return 'clicked'; }
      return 'missing';
    })()`).then((result) => console.log('new-task', result));
    await waitFor(client, (state) => state.composer && state.contextBar && state.rows === 0, 15_000, 'second draft');
    await sleep(800);
    await typeAndSubmit(client, 'Second draft prompt\nsecond line\nthird line', { record: true });
    await sleep(recordMs);
    const second = await client.evaluate('window.__probe.stop()');
    captures['second-draft-first-submit'] = second;
    report('second-draft-first-submit', second);
  }
  if (!argumentsList.includes('--only-draft')) {
  await settleTurn(client, 'first');

  // Seed history so the transcript scrolls, then measure a mid-session submit.
  for (let index = 0; index < historyTurns; index += 1) {
    await typeAndSubmit(client, `History prompt ${index}\n` + 'A wrapped sentence to give the row some height. '.repeat(3), { record: false });
    await settleTurn(client, `history ${index}`);
  }
  console.log('before-session-submit', JSON.stringify(await evaluateStable(client, STATE)));
  await typeAndSubmit(client, 'Probe session prompt\nsecond line\nthird line\nfourth line', { record: true });
  await sleep(recordMs);
  const session = await client.evaluate('window.__probe.stop()');
  captures['session-submit-multiline'] = session;
  report('session-submit-multiline', session);
  await settleTurn(client, 'session');
  await typeAndSubmit(client, 'Probe single line prompt', { record: true });
  await sleep(recordMs);
  const single = await client.evaluate('window.__probe.stop()');
  captures['session-submit-single'] = single;
  report('session-submit-single', single);
  console.log('final', JSON.stringify(await evaluateStable(client, STATE)));
  }
  const { writeFile } = await import('node:fs/promises');
  const rawPath = join(desktopDir, 'artifacts', 'submit-shift-probe.json');
  await writeFile(rawPath, JSON.stringify(captures));
  console.log('raw frames:', rawPath);
} finally {
  await stopApp(client, child);
  if (!keepProfile) await rm(profilePath, { recursive: true, force: true }).catch(() => undefined);
}
