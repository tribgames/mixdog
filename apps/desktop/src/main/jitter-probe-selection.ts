/**
 * Transcript selection-drag probe (MIXDOG_JITTER_PROBE=select through the
 * capture window): reproduces "drag a transcript selection into the composer
 * or out of the window" with REAL Chromium input events and records what
 * the document Selection, focus, and the drag markers did at every step.
 *
 * Reporting pass: the JSON is read by a human chasing a reversed or lost
 * selection (user: 컴포저 영역으로 끌면 포커싱을 잃고 드래그가 뒤집힘).
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { screen, type BrowserWindow } from 'electron';
import { paragraph, probeItems } from './jitter-probe-fixtures';
import { RealMouse } from './jitter-probe-real-mouse';

type Snapshot = Record<string, unknown>;
type Point = { x: number; y: number };

interface SelectionProbeDeps {
  window: BrowserWindow;
  baseSnapshot: Snapshot;
  prepareColdResume(snapshot: Snapshot): void;
  send(state: Snapshot): void;
  outPath: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Installs the observer once; `sample(label)` reads the live state. */
const INSTALL_SCRIPT = `(() => {
  if (window.__selProbe) { window.__selProbe.events = []; return true; }
  const transcript = () => document.querySelector(window.__selProbeTranscript);
  const describe = (node) => {
    if (!node) return null;
    const element = node instanceof Element ? node : node.parentElement;
    if (!element) return String(node.nodeName);
    const row = element.closest('.transcript-virtual-row');
    const cls = String(element.className || '').split(/\\s+/).slice(0, 3).join('.');
    return (element.tagName.toLowerCase() + (cls ? '.' + cls : ''))
      + (row ? '#row' + row.dataset.index : '')
      + (element.closest('form.composer') ? '@composer' : '')
      + (element.closest('.transcript') ? '@transcript' : '');
  };
  const rowOf = (node) => {
    const element = node instanceof Element ? node : node?.parentElement;
    const row = element?.closest?.('.transcript-virtual-row');
    return row ? Number(row.dataset.index) : null;
  };
  const state = () => {
    const s = window.getSelection();
    const root = transcript();
    return {
      anchorRow: rowOf(s?.anchorNode), anchorOffset: s?.anchorOffset ?? null,
      focusRow: rowOf(s?.focusNode), focusOffset: s?.focusOffset ?? null,
      anchorIn: describe(s?.anchorNode), focusIn: describe(s?.focusNode),
      collapsed: s ? s.isCollapsed : null, rangeCount: s?.rangeCount ?? 0,
      textLength: s ? s.toString().length : 0,
      active: describe(document.activeElement),
      transcriptSelecting: document.documentElement.dataset.transcriptSelecting ?? null,
      paneSelecting: document.documentElement.dataset.paneSelecting ?? null,
      scrollTop: root ? Math.round(root.scrollTop) : null,
      mountedRows: root ? root.querySelectorAll('.transcript-virtual-row').length : 0,
      windowFocused: document.hasFocus(),
      moves: probe.moves, lastMove: probe.lastMove,
    };
  };
  const probe = { events: [], state, moves: 0, lastMove: null };
  const push = (type, event) => probe.events.push({
    t: Math.round(performance.now()), type,
    target: describe(event?.target),
    buttons: event?.buttons, x: event?.clientX, y: event?.clientY,
    ...state(),
  });
  document.addEventListener('selectionchange', (e) => push('selectionchange', e));
  document.addEventListener('focusin', (e) => push('focusin', e), true);
  document.addEventListener('focusout', (e) => push('focusout', e), true);
  document.addEventListener('pointerdown', (e) => push('pointerdown', e), true);
  document.addEventListener('pointerup', (e) => push('pointerup', e), true);
  document.addEventListener('pointercancel', (e) => push('pointercancel', e), true);
  document.addEventListener('click', (e) => push('click', e), true);
  document.addEventListener('dragstart', (e) => push('dragstart', e), true);
  document.addEventListener('pointerleave', (e) => push('pointerleave', e), true);
  window.addEventListener('blur', (e) => push('window-blur', e));
  window.addEventListener('focus', (e) => push('window-focus', e));
  document.addEventListener('lostpointercapture', (e) => push('lostpointercapture', e), true);
  document.addEventListener('gotpointercapture', (e) => push('gotpointercapture', e), true);
  document.addEventListener('mouseleave', (e) => {
    if (e.target === document.documentElement) push('html-mouseleave', e);
  }, true);
  let lastButtons = -1;
  document.addEventListener('pointermove', (e) => {
    probe.moves += 1;
    probe.lastMove = { t: Math.round(performance.now()), x: e.clientX, y: e.clientY, buttons: e.buttons };
    if (e.buttons === lastButtons) return;
    lastButtons = e.buttons;
    push('pointermove-buttons-changed', e);
  }, true);
  window.__selProbe = probe;
  return true;
})()`;

const GEOMETRY_SCRIPT = `(() => {
  const root = document.querySelector(window.__selProbeTranscript);
  if (!root) return null;
  const view = root.getBoundingClientRect();
  const rows = [...root.querySelectorAll('.transcript-virtual-row')]
    .filter((row) => {
      const r = row.getBoundingClientRect();
      return r.top >= view.top + 40 && r.bottom <= view.bottom - 40 && r.height > 24;
    });
  const pick = rows[Math.floor(rows.length / 2)] || rows[0];
  if (!pick) return null;
  const text = pick.querySelector('p, li, code, span') || pick;
  const box = text.getBoundingClientRect();
  const textarea = root.closest('.conversation, .pane-chat-surface, .workspace')?.querySelector('form.composer textarea')
    || document.querySelector('form.composer textarea');
  const ta = textarea ? textarea.getBoundingClientRect() : null;
  return {
    view: { left: view.left, top: view.top, right: view.right, bottom: view.bottom },
    row: { index: Number(pick.dataset.index), x: box.left + Math.min(24, box.width / 2), y: box.top + Math.min(10, box.height / 2) },
    textarea: ta ? { x: ta.left + ta.width / 2, y: ta.top + ta.height / 2, top: ta.top, bottom: ta.bottom } : null,
    inner: { width: window.innerWidth, height: window.innerHeight },
  };
})()`;

export async function runSelectionProbe({
  window,
  baseSnapshot,
  prepareColdResume,
  send,
  outPath,
}: SelectionProbeDeps): Promise<{ reversals: number }> {
  const snapshot = {
    ...baseSnapshot,
    toasts: [],
    sessionId: 'probe_session_cold',
    // Same shape as the width pass, which is known to enter through the cold
    // resume path and render the timeline.
    busy: true,
    spinner: { active: true, mode: 'responding', startedAt: Date.now() },
    items: probeItems(120),
    streamingTail: {
      id: 'probe-select-live',
      kind: 'assistant',
      text: paragraph(123, 12),
      streaming: true,
    },
  };
  const consoleErrors: string[] = [];
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') {
      consoleErrors.push(`${event.level}: ${event.message} (${event.sourceId}:${event.lineNumber})`);
    }
  });
  window.setBounds({ ...window.getBounds(), width: 1_920, height: 900 });
  await sleep(400);
  prepareColdResume(snapshot);
  // Enter through the real cold-resume path first; when that route does not
  // own the transcript, fall back to a real composer submit on the open
  // draft tab (CaptureService mints a capture_* session for it) and push the
  // fixture items to THAT session id.
  const entered = await window.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const cold = document.querySelector('[data-session-id="probe_session_cold"]');
    if (cold instanceof HTMLElement) { cold.click(); await wait(900); }
    if (document.querySelector('.transcript[data-session-key="probe_session_cold"]')) {
      return 'probe_session_cold';
    }
    const draft = document.querySelector('.session-new-task')
      || document.querySelector('button[aria-label="New task"]');
    if (draft instanceof HTMLElement) { draft.click(); await wait(500); }
    const ta = document.querySelector('form.composer textarea');
    if (!(ta instanceof HTMLTextAreaElement)) throw new Error('selection probe: no draft composer');
    ta.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, 'selection probe');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(150);
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await wait(100);
      const session = [...document.querySelectorAll('.transcript[data-session-key]')]
        .map((node) => node.dataset.sessionKey)
        .find((key) => key && key !== 'new-task');
      if (session) return session;
    }
    return '';
  })()`) as string;
  if (!entered) throw new Error('selection probe: could not enter a session');
  const sessionId = entered;
  await window.webContents.executeJavaScript(
    `window.__selProbeTranscript = ${JSON.stringify(`.transcript[data-session-key="${sessionId}"]`)}; true`,
  );
  send({ ...snapshot, sessionId });
  await sleep(1_200);
  const ready = await window.webContents.executeJavaScript(`(async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const node = document.querySelector('.transcript[data-session-key=${JSON.stringify(sessionId)}]');
      const rows = node ? node.querySelectorAll('.transcript-virtual-row').length : 0;
      if (node && rows > 3) {
        // Read from the middle so native autoscroll has room both ways.
        node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }));
        node.scrollTop = Math.round((node.scrollHeight - node.clientHeight) * 0.5);
        node.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { rows };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return {
      rows: 0,
      transcripts: document.querySelectorAll('.transcript').length,
      tabs: document.querySelectorAll('.workspace-tab').length,
      text: (document.body.innerText || '').slice(0, 200).replace(/\\s+/g, ' '),
      toasts: [...document.querySelectorAll('[role="status"], [role="alert"], .toast, .notification')]
        .map((node) => (node.textContent || '').trim().slice(0, 300)),
      activeTab: [...document.querySelectorAll('.workspace-tab[data-active="true"]')]
        .map((node) => (node.textContent || '').trim()),
      transcriptHtml: document.querySelector('.transcript')?.outerHTML.slice(0, 600) ?? null,
    };
  })()`) as { rows: number };
  if (!ready.rows) {
    throw new Error(`selection probe: transcript never rendered ${JSON.stringify(ready)}\nconsole: ${consoleErrors.slice(0, 12).join('\n')}`);
  }

  // The isolated capture profile may raise the onboarding wizard over the
  // workbench; a real pointer must reach the transcript, so skip it.
  const wizard = await window.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    for (let attempt = 0; attempt < 10 && document.querySelector('.onboarding-layer'); attempt += 1) {
      document.querySelector('.onboarding-dialog footer button.secondary')?.click();
      await wait(250);
      document.querySelector('.settings-confirm-dialog footer button:last-child')?.click();
      await wait(600);
    }
    if (document.querySelector('.onboarding-layer')) {
      document.querySelector('.onboarding-layer').remove();
      return 'removed';
    }
    return 'closed';
  })()`);
  console.log(`[jitter-probe] onboarding: ${String(wizard)}`);
  const debug = window.webContents.debugger;
  if (!debug.isAttached()) debug.attach('1.3');
  const mouse = async (
    type: 'mousePressed' | 'mouseReleased' | 'mouseMoved',
    point: Point,
  ) => {
    await debug.sendCommand('Input.dispatchMouseEvent', {
      type,
      x: Math.round(point.x),
      y: Math.round(point.y),
      button: type === 'mouseMoved' ? 'left' : 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: type === 'mouseMoved' ? 0 : 1,
      pointerType: 'mouse',
    });
  };
  const sample = (label: string) => window.webContents.executeJavaScript(
    `({ label: ${JSON.stringify(label)}, ...window.__selProbe.state() })`,
  ) as Promise<Record<string, unknown>>;
  const events = () => window.webContents.executeJavaScript(
    '(() => { const e = window.__selProbe.events; window.__selProbe.events = []; return e; })()',
  ) as Promise<unknown[]>;
  const geometry = () => window.webContents.executeJavaScript(GEOMETRY_SCRIPT) as Promise<{
    view: { left: number; top: number; right: number; bottom: number };
    row: { index: number; x: number; y: number };
    textarea: { x: number; y: number; top: number; bottom: number } | null;
    inner: { width: number; height: number };
  } | null>;

  const glide = async (from: Point, to: Point, steps: number, label: string, out: unknown[]) => {
    for (let step = 1; step <= steps; step += 1) {
      const point = {
        x: from.x + ((to.x - from.x) * step) / steps,
        y: from.y + ((to.y - from.y) * step) / steps,
      };
      await mouse('mouseMoved', point);
      await sleep(16);
      if (step === steps || step % Math.max(1, Math.floor(steps / 3)) === 0) {
        out.push({ ...(await sample(`${label} step ${step}/${steps}`)), at: point });
      }
    }
  };

  const scenario = async (
    name: string,
    drive: (g: NonNullable<Awaited<ReturnType<typeof geometry>>>, out: unknown[]) => Promise<void>,
  ) => {
    // Reset: collapse any range, blur the composer, re-centre the transcript.
    await window.webContents.executeJavaScript(`(() => {
      window.getSelection()?.removeAllRanges();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      const node = document.querySelector(window.__selProbeTranscript);
      node.scrollTop = Math.round((node.scrollHeight - node.clientHeight) * 0.5);
      node.dispatchEvent(new Event('scroll', { bubbles: true }));
      return true;
    })()`);
    await sleep(400);
    await window.webContents.executeJavaScript(INSTALL_SCRIPT);
    const g = await geometry();
    if (!g || !g.textarea) throw new Error(`selection probe: geometry unavailable ${JSON.stringify(g)}`);
    const steps: unknown[] = [];
    steps.push({ ...(await sample('before')), geometry: g });
    await mouse('mouseMoved', g.row);
    await sleep(30);
    await mouse('mousePressed', g.row);
    await sleep(60);
    steps.push(await sample('pressed'));
    await drive(g, steps);
    await sleep(350);
    steps.push(await sample('settled'));
    return { name, steps, events: await events() };
  };

  const report: Record<string, unknown> = {};
  // A. Drag from the row down onto the composer textarea and release there.
  report.intoComposer = await scenario('intoComposer', async (g, out) => {
    const ta = g.textarea!;
    await glide(g.row, { x: g.row.x, y: g.view.bottom - 8 }, 12, 'to viewport bottom', out);
    await glide({ x: g.row.x, y: g.view.bottom - 8 }, { x: ta.x, y: ta.y }, 8, 'into textarea', out);
    await sleep(500);
    out.push(await sample('held on textarea'));
    await mouse('mouseReleased', { x: ta.x, y: ta.y });
    await sleep(60);
    out.push(await sample('released on textarea'));
  });
  // B. Drag below the window (past the composer), hold for autoscroll, come
  //    back to the composer and release.
  report.belowWindow = await scenario('belowWindow', async (g, out) => {
    const ta = g.textarea!;
    const below = { x: g.row.x, y: g.inner.height + 160 };
    await glide(g.row, { x: ta.x, y: ta.y }, 12, 'through composer', out);
    await glide({ x: ta.x, y: ta.y }, below, 6, 'below window', out);
    await sleep(900);
    out.push(await sample('held below window'));
    await glide(below, { x: ta.x, y: ta.y }, 6, 'back to textarea', out);
    await mouse('mouseReleased', { x: ta.x, y: ta.y });
    await sleep(60);
    out.push(await sample('released on textarea'));
  });
  // C. Drag above the window, hold, release outside.
  report.aboveWindow = await scenario('aboveWindow', async (g, out) => {
    const above = { x: g.row.x, y: -160 };
    await glide(g.row, { x: g.row.x, y: g.view.top + 8 }, 8, 'to viewport top', out);
    await glide({ x: g.row.x, y: g.view.top + 8 }, above, 6, 'above window', out);
    await sleep(900);
    out.push(await sample('held above window'));
    await mouse('mouseReleased', above);
    await sleep(60);
    out.push(await sample('released above window'));
  });
  // D. Drag out of the window's left edge, hold, release outside.
  report.sideWindow = await scenario('sideWindow', async (g, out) => {
    const side = { x: -160, y: g.row.y + 40 };
    await glide(g.row, { x: g.view.left + 4, y: g.row.y + 40 }, 8, 'to viewport edge', out);
    await glide({ x: g.view.left + 4, y: g.row.y + 40 }, side, 6, 'outside left', out);
    await sleep(900);
    out.push(await sample('held outside left'));
    await mouse('mouseReleased', side);
    await sleep(60);
    out.push(await sample('released outside left'));
  });

  // E. Drag out of the window's RIGHT edge — across the transcript's reserved
  //    scrollbar gutter, the exit the user reported (앱 창 밖으로 드래그).
  report.sideWindowRight = await scenario('sideWindowRight', async (g, out) => {
    const side = { x: g.inner.width + 160, y: g.row.y + 40 };
    await glide(g.row, { x: g.view.right - 4, y: g.row.y + 40 }, 8, 'to viewport edge', out);
    await glide({ x: g.view.right - 4, y: g.row.y + 40 }, side, 6, 'outside right', out);
    await sleep(900);
    out.push(await sample('held outside right'));
    await mouse('mouseReleased', side);
    await sleep(60);
    out.push(await sample('released outside right'));
  });

  // F. Hover the composer boundary pixel by pixel, sampling every step: the
  //    focus row must move monotonically, never jump to a boundary row.
  report.composerBoundary = await scenario('composerBoundary', async (g, out) => {
    const x = g.row.x;
    for (let y = g.view.bottom - 12; y <= g.view.bottom + 12; y += 2) {
      await mouse('mouseMoved', { x, y });
      await sleep(40);
      out.push({ ...(await sample(`hover y=${Math.round(y - g.view.bottom)}`)), at: { x, y } });
    }
    await mouse('mouseReleased', { x, y: g.view.bottom + 12 });
    await sleep(60);
    out.push(await sample('released at boundary'));
  });

  // MIXDOG_SELECT_REAL_MOUSE=1: the same exits driven by the REAL OS mouse,
  // leaving the window itself. The window is shrunk and centred so every
  // edge has desktop beyond it.
  if (process.env.MIXDOG_SELECT_REAL_MOUSE === '1') {
    console.log('[jitter-probe] real mouse pass: start');
    const display = screen.getPrimaryDisplay();
    const scale = display.scaleFactor || 1;
    window.setBounds({ x: 400, y: 260, width: 1_400, height: 800 });
    window.setAlwaysOnTop(true);
    window.focus();
    window.moveTop();
    await sleep(600);
    const mouseDriver = new RealMouse(
      Math.round(display.size.width * scale),
      Math.round(display.size.height * scale),
    );
    const toScreen = (point: Point): Point => {
      const content = window.getContentBounds();
      return { x: (content.x + point.x) * scale, y: (content.y + point.y) * scale };
    };
    const realGlide = async (from: Point, to: Point, steps: number, label: string, out: unknown[]) => {
      for (let step = 1; step <= steps; step += 1) {
        const point = {
          x: from.x + ((to.x - from.x) * step) / steps,
          y: from.y + ((to.y - from.y) * step) / steps,
        };
        const at = toScreen(point);
        await mouseDriver.move(at.x, at.y);
        await sleep(24);
        if (step === steps || step % Math.max(1, Math.floor(steps / 3)) === 0) {
          out.push({ ...(await sample(`${label} step ${step}/${steps}`)), at: point });
        }
      }
    };
    const realScenario = async (
      name: string,
      exit: (g: NonNullable<Awaited<ReturnType<typeof geometry>>>) => { edge: Point; outside: Point },
    ) => {
      await window.webContents.executeJavaScript(`(() => {
        window.getSelection()?.removeAllRanges();
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        const node = document.querySelector(window.__selProbeTranscript);
        node.scrollTop = Math.round((node.scrollHeight - node.clientHeight) * 0.5);
        node.dispatchEvent(new Event('scroll', { bubbles: true }));
        return true;
      })()`);
      await sleep(400);
      await window.webContents.executeJavaScript(INSTALL_SCRIPT);
      const g = await geometry();
      if (!g) throw new Error('selection probe: geometry unavailable for the real pass');
      const steps: unknown[] = [];
      const { edge, outside } = exit(g);
      steps.push({ ...(await sample('before')), geometry: g, edge, outside });
      const start = toScreen(g.row);
      await mouseDriver.move(start.x, start.y);
      await sleep(80);
      console.log(`[jitter-probe] real ${name}: press at ${JSON.stringify(start)}`
        + ` cursor=${JSON.stringify(screen.getCursorScreenPoint())}`
        + ` bounds=${JSON.stringify(window.getBounds())}`
        + ` content=${JSON.stringify(window.getContentBounds())}`
        + ` focused=${window.isFocused()} visible=${window.isVisible()}`);
      await mouseDriver.down();
      await sleep(80);
      steps.push(await sample('pressed'));
      console.log(`[jitter-probe] real ${name}: pressed`);
      await realGlide(g.row, edge, 10, 'to window edge', steps);
      await realGlide(edge, outside, 8, 'outside window', steps);
      await sleep(900);
      steps.push(await sample('held outside'));
      console.log(`[jitter-probe] real ${name}: held outside`);
      // Come back in a little (still outside the viewport) — the moment the
      // user reported: the range should follow, not flip.
      const back = { x: (edge.x + outside.x) / 2, y: (edge.y + outside.y) / 2 };
      await realGlide(outside, back, 4, 'back toward window', steps);
      await sleep(300);
      steps.push(await sample('held near edge'));
      await mouseDriver.up();
      await sleep(120);
      steps.push(await sample('released outside'));
      await sleep(300);
      steps.push(await sample('settled'));
      return { name, steps, events: await events() };
    };
    try {
      report.realRight = await realScenario('realRight', (g) => ({
        edge: { x: g.inner.width - 4, y: g.row.y + 30 },
        outside: { x: g.inner.width + 180, y: g.row.y + 30 },
      }));
      report.realBelow = await realScenario('realBelow', (g) => ({
        edge: { x: g.row.x, y: g.inner.height - 4 },
        outside: { x: g.row.x, y: g.inner.height + 180 },
      }));
      report.realAbove = await realScenario('realAbove', (g) => ({
        edge: { x: g.row.x, y: 4 },
        outside: { x: g.row.x, y: -180 },
      }));
      report.realLeft = await realScenario('realLeft', (g) => ({
        edge: { x: 4, y: g.row.y + 30 },
        outside: { x: -180, y: g.row.y + 30 },
      }));
    } finally {
      await mouseDriver.dispose();
    }
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ summary: report }, null, 1));
  const brief = Object.fromEntries(Object.entries(report).map(([name, value]) => {
    const steps = (value as { steps: Array<Record<string, unknown>> }).steps;
    return [name, steps.map((step) => [
      step.label, step.anchorRow, step.focusRow, step.collapsed, step.textLength, step.active,
      step.transcriptSelecting, step.moves,
    ])];
  }));
  console.log(`[jitter-probe] ${JSON.stringify(brief)}`);
  return { reversals: 0 };
}
