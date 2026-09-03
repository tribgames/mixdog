// Reproduces "pane focus blanks the tab labels": boots an isolated profile
// with a two-pane column layout whose SECOND pane holds five tabs, clicks
// into that pane, and dumps the strip's DOM state plus a screenshot before
// and after the focus change.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectPath = resolve(desktopDir, '..', '..');
const artifactDir = join(desktopDir, 'artifacts', 'tab-focus-probe');
const profilePath = join(artifactDir, `profile-${Date.now()}`);
const electron = join(desktopDir, 'node_modules', 'electron', 'dist', 'electron.exe');
const port = 9333;

class Cdp {
  constructor(url) { this.socket = new WebSocket(url); this.next = 1; this.pending = new Map(); }
  connect() {
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const pending = message.id && this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    return new Promise((ok, fail) => {
      this.socket.addEventListener('open', ok, { once: true });
      this.socket.addEventListener('error', () => fail(new Error('cdp failed')), { once: true });
    });
  }
  request(method, params = {}) {
    const id = this.next++;
    return new Promise((ok, fail) => {
      this.pending.set(id, { resolve: ok, reject: fail });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.request('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function waitForTarget(child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`electron exited ${child.exitCode}`);
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const target = targets.find((t) => t.type === 'page' && t.url?.includes('/out/renderer/index.html'));
      if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
    } catch { /* not yet */ }
    await sleep(50);
  }
  throw new Error('no cdp target');
}

async function evaluateStable(client, expression, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try { return await client.evaluate(expression); } catch (error) {
      last = error;
      if (!/Execution context was destroyed|Cannot find context|localStorage/i.test(String(error.message))) throw error;
      await sleep(100);
    }
  }
  throw last;
}

const SETTLE = `(async () => {
  const deadline = performance.now() + 20000;
  while (!window.__mixdogStartupSettled && performance.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  if (!window.__mixdogStartupSettled) throw new Error('did not settle');
  return performance.timeOrigin;
})()`;

const DUMP = `(() => {
  const shells = [...document.querySelectorAll('.workspace-tabs-shell')];
  return shells.map((shell) => {
    const pane = shell.closest('[data-pane-id]')?.dataset.paneId;
    const trailing = shell.querySelector(':scope > .workspace-tabs-trailing');
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
    return {
      pane,
      focused: shell.dataset.focused,
      shell: rect(shell),
      trailing: trailing ? { rect: rect(trailing), children: trailing.children.length, display: getComputedStyle(trailing).display } : null,
      tabs: [...shell.querySelectorAll('.workspace-tab')].map((tab) => {
        const span = tab.querySelector('.workspace-tab-main span');
        const svg = tab.querySelector('.workspace-tab-main svg');
        return {
          active: tab.dataset.active,
          width: tab.style.getPropertyValue('--workspace-tab-current-width'),
          rect: rect(tab),
          label: span?.textContent ?? null,
          labelDisplay: span ? getComputedStyle(span).display : null,
          labelRect: rect(span),
          labelColor: span ? getComputedStyle(span).color : null,
          labelOpacity: span ? getComputedStyle(span).opacity : null,
          labelVisibility: span ? getComputedStyle(span).visibility : null,
          iconRect: rect(svg),
          closeRect: rect(tab.querySelector('.workspace-tab-close')),
        };
      }),
    };
  });
})()`;

async function screenshot(client, name) {
  const { data } = await client.request('Page.captureScreenshot', { format: 'png' });
  const file = join(artifactDir, `${name}.png`);
  await writeFile(file, Buffer.from(data, 'base64'));
  return file;
}

async function main() {
  await rm(artifactDir, { recursive: true, force: true }).catch(() => undefined);
  await Promise.all(['runtime', 'data', 'home'].map((d) => mkdir(join(profilePath, d), { recursive: true })));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('MIXDOG_') || key.startsWith('ELECTRON_')) delete env[key];
  Object.assign(env, {
    MIXDOG_DESKTOP_USER_DATA: profilePath,
    MIXDOG_RUNTIME_ROOT: join(profilePath, 'runtime'),
    MIXDOG_DATA_DIR: join(profilePath, 'data'),
    MIXDOG_HOME: join(profilePath, 'home'),
    MIXDOG_BOOT_SCENARIO: 'tab-focus-probe',
  });
  const child = spawn(electron, [desktopDir, `--remote-debugging-port=${port}`, '--window-size=1600,1000'], {
    cwd: desktopDir, env, stdio: 'ignore', windowsHide: false,
  });
  const client = new Cdp(await waitForTarget(child));
  await client.connect();
  const report = {};
  try {
    await evaluateStable(client, SETTLE);
    const seeded = await client.evaluate(`(async () => {
      await window.mixdogDesktop.addProject(${JSON.stringify(projectPath)});
      await window.mixdogDesktop.invokeCapability({ capability: 'skipOnboarding', args: [] }).catch(() => undefined);
      const titles = [
        '트랜스크립트 렌더링 지연 원인 조사와 개선',
        '컴팩션 구조 개선점 검토 및 정리',
        '로컬 배포 설정 확인과 재배포 절차',
        'PPT 방향성과 외부 스킬 대조',
      ];
      const ids = [];
      for (const title of titles) {
        const fixture = await window.mixdogDesktop.submitNewTask(title, {
          id: 'tab-focus-fixture', displayText: title, goalCommand: title,
        });
        await window.mixdogDesktop.invokeCapability({ capability: 'goalControl', args: [{ command: 'pause' }], sessionId: fixture.sessionId }).catch(() => undefined);
        ids.push(fixture.sessionId);
        await new Promise((r) => setTimeout(r, 300));
      }
      let rows = [];
      const deadline = performance.now() + 10000;
      while (rows.length < ids.length && performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
        rows = await window.mixdogDesktop.listSessions().catch(() => []);
      }
      const project = ${JSON.stringify(projectPath)};
      const known = rows.map((row) => row.id).filter(Boolean);
      const sessionId = known[0];
      const fillers = [
        { kind: 'file', project, rel: 'apps/desktop/package.json' },
        { kind: 'file', project, rel: 'README.md' },
        { kind: 'file', project, rel: 'apps/desktop/electron.vite.config.ts' },
        { kind: 'file', project, rel: 'docs/testing.md' },
      ];
      const tabs = [{ kind: 'new', draftId: 'probe-draft' }];
      for (let i = 0; i < 4; i += 1) tabs.push(known[i] ? { kind: 'session', id: known[i] } : fillers[i]);
      const key = (s) => s.kind === 'new' ? 'new:' + s.draftId : s.kind === 'file' ? 'file:' + s.project + ':' + s.rel : 'session:' + s.id;
      const leaf = (id, t, active) => ({ type: 'leaf', id, tabs: t, activeKey: key(active) });
      const layout = {
        type: 'split', direction: 'row', ratio: 0.5,
        first: {
          type: 'split', direction: 'column', ratio: 0.5,
          first: leaf('top', [{ kind: 'new', draftId: 'tl' }], { kind: 'new', draftId: 'tl' }),
          second: leaf('bottom', tabs, tabs[1]),
        },
        second: {
          type: 'split', direction: 'column', ratio: 0.5,
          first: leaf('tr', [{ kind: 'new', draftId: 'tr' }], { kind: 'new', draftId: 'tr' }),
          second: leaf('br', [{ kind: 'new', draftId: 'br' }], { kind: 'new', draftId: 'br' }),
        },
      };
      const persist = () => {
        localStorage.setItem('mixdog.desktop.pane-layout.v1', JSON.stringify({ layout, focusedLeafId: 'top' }));
        localStorage.setItem('mixdog.desktop-sidebar-open.v1', 'false');
        localStorage.setItem('mixdog.desktop.workbench-side-view-layout.pane-bound-right.v1', '1');
        localStorage.setItem('mixdog.desktop.workbench-side-view-layout.v1', JSON.stringify({
          left: [['agents'], ['sessions'], ['projects']],
          right: [['source-control'], ['browser'], ['terminal'], ['pull-requests']],
        }));
        localStorage.setItem('mixdog.desktop.pane-side-dock.v1', '{}');
        localStorage.setItem('mixdog.desktop.bottom-panel.v1', JSON.stringify({ open: false, tab: 'terminal', height: 240 }));
        localStorage.setItem('mixdog.desktop-last-session.v1', sessionId);
      };
      persist();
      window.addEventListener('pagehide', persist, { once: true });
      return { sessionId, timeOrigin: performance.timeOrigin };
    })()`);
    report.seeded = seeded;
    try { await client.evaluate('window.location.reload(); true'); } catch { /* context swap */ }
    await evaluateStable(client, `(async () => {
      const previous = ${JSON.stringify(seeded.timeOrigin)};
      const deadline = performance.now() + 20000;
      while ((performance.timeOrigin === previous || !window.__mixdogStartupSettled) && performance.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      if (performance.timeOrigin === previous || !window.__mixdogStartupSettled) throw new Error('no restore');
      return true;
    })()`);
    await client.evaluate(`(async () => {
      const bridge = window.mixdogDesktop;
      try { await bridge?.windowControl?.('maximize'); } catch {}
      try { await bridge?.maximizeWindow?.(); } catch {}
      return true;
    })()`).catch(() => undefined);
    await sleep(3_000);
    report.before = await client.evaluate(DUMP);
    report.beforeShot = await screenshot(client, 'before');
    // Click into the bottom pane's composer (a plain pane focus, no tab switch).
    const target = await client.evaluate(`(() => {
      const pane = document.querySelector('[data-pane-id="bottom"]');
      const el = pane?.querySelector('form.composer textarea') || pane;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    report.clickAt = target;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await client.request('Input.dispatchMouseEvent', { type, x: target.x, y: target.y, button: 'left', clickCount: 1 });
    }
    await sleep(700);
    report.after = await client.evaluate(DUMP);
    report.afterShot = await screenshot(client, 'after');
    // A second click back on the top pane, then the bottom again.
    const top = await client.evaluate(`(() => { const r = document.querySelector('[data-pane-id="top"] form.composer textarea').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    for (const p of [top, target]) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await client.request('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
      }
      await sleep(500);
    }
    // Vertical rhythm inside one strip: centre-Y of every glyph class against
    // the tab cell centre (user: X는 상하 정렬 맞는 거냐, 닷하고 스피너도?).
    report.rhythm = await client.evaluate(`(() => {
      const shell = document.querySelector('[data-pane-id="bottom"] .workspace-tabs-shell');
      const tab = shell?.querySelector('.workspace-tab.active');
      if (!tab) return null;
      const cy = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return +((r.top + r.height / 2).toFixed(2)); };
      const span = tab.querySelector('.workspace-tab-main span');
      const range = document.createRange(); range.selectNodeContents(span);
      const glyphs = range.getBoundingClientRect();
      return {
        cell: cy(tab),
        icon: cy(tab.querySelector('.workspace-tab-main svg')),
        labelBox: cy(span),
        labelGlyphLine: +((glyphs.top + glyphs.height / 2).toFixed(2)),
        labelGlyphHeight: +glyphs.height.toFixed(2),
        close: cy(tab.querySelector('.workspace-tab-close .codicon')),
        closeButton: cy(tab.querySelector('.workspace-tab-close')),
        closeGlyphHeight: tab.querySelector('.workspace-tab-close .codicon')?.getBoundingClientRect().height ?? null,
        plus: cy(shell.querySelector('.workspace-tab-new :is(svg, .codicon)')),
        plusKind: shell.querySelector('.workspace-tab-new :is(svg, .codicon)')?.tagName ?? null,
        plusGlyphHeight: shell.querySelector('.workspace-tab-new :is(svg, .codicon)')?.getBoundingClientRect().height ?? null,
        iconHeight: tab.querySelector('.workspace-tab-main svg')?.getBoundingClientRect().height ?? null,
        dockToggle: cy(document.querySelector('.pane-dock-toggle svg')),
      };
    })()`);
    report.afterSecond = await client.evaluate(DUMP);
    report.afterSecondShot = await screenshot(client, 'after-second');
  } finally {
    await writeFile(join(artifactDir, 'report.json'), JSON.stringify(report, null, 2));
    try { await client.evaluate('window.mixdogDesktop?.quit?.()'); } catch { /* fallback below */ }
    await Promise.race([new Promise((ok) => child.once('exit', ok)), sleep(4_000)]);
    if (child.exitCode === null) child.kill();
  }
  console.log(JSON.stringify({
    before: report.before?.map((s) => ({ pane: s.pane, focused: s.focused, trailing: s.trailing?.rect, tabs: s.tabs.map((t) => [t.label, t.labelDisplay, t.labelRect, t.iconRect]) })),
    after: report.after?.map((s) => ({ pane: s.pane, focused: s.focused, trailing: s.trailing?.rect, tabs: s.tabs.map((t) => [t.label, t.labelDisplay, t.labelRect, t.iconRect]) })),
    shots: [report.beforeShot, report.afterShot, report.afterSecondShot],
  }, null, 1));
}

main().catch((error) => { console.error(error); process.exit(1); });
