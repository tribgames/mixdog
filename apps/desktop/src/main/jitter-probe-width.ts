/**
 * Width pass (MIXDOG_JITTER_PROBE=width): measures a REAL window-width drag
 * and a REAL pane-sash drag — who writes scrollTop, and how far the reader's
 * row moves per rewrap step.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrowserWindow } from 'electron';
import { paragraph, probeItems } from './jitter-probe-fixtures';
import { WIDTH_TRACE_COLLECT_SCRIPT, WIDTH_TRACE_INSTALL_SCRIPT } from './jitter-probe-width-scripts';
import { dragProbeSash, readProbeSash } from './jitter-probe-sash';

interface WidthProbeDeps {
  window: BrowserWindow;
  baseSnapshot: Record<string, unknown>;
  prepareColdResume(snapshot: Record<string, unknown>): void;
  send(state: Record<string, unknown>): void;
  outPath: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runWidthProbe({
  window,
  baseSnapshot,
  prepareColdResume,
  send,
  outPath,
}: WidthProbeDeps): Promise<{ reversals: number }> {
  // Enter through the real resume path: a snapshot pushed for a session the
  // visible route does not own is suppressed as a foreign frame.
  const widthSnapshot = {
    ...baseSnapshot,
    toasts: [],
    sessionId: 'probe_session_cold',
    busy: true,
    spinner: {
      active: true,
      mode: 'responding',
      startedAt: Date.now(),
    },
    // Real sessions carry multi-hundred-line fenced answers: those rows are
    // the ones whose rewrap moves the viewport by hundreds of pixels.
    // 200 rows also leaves most of the timeline UNMEASURED (flat estimate),
    // which is the state a long working session is really in.
    items: probeItems(200),
    streamingTail: {
      id: 'probe-width-live',
      kind: 'assistant',
      text: paragraph(203, 50),
      streaming: true,
    },
  };
  window.setBounds({ ...window.getBounds(), width: 1_920, height: 900 });
  await sleep(400);
  prepareColdResume(widthSnapshot);
  await window.webContents.executeJavaScript(`(async () => {
    const row = document.querySelector('[data-session-id="probe_session_cold"]');
    if (!(row instanceof HTMLElement)) throw new Error('Missing cold probe session row');
    row.click();
    await new Promise((resolve) => setTimeout(resolve, 700));
    return true;
  })()`);
  send(widthSnapshot);
  await sleep(1_200);
  const ready = await window.webContents.executeJavaScript(`(async () => {
    const visible = () => [...document.querySelectorAll('.transcript')]
      .find((node) => node.getBoundingClientRect().height > 0);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const node = visible();
      const rows = node ? node.querySelectorAll('.transcript-virtual-row').length : 0;
      if (node && rows > 3) {
        return { rows, height: Math.round(node.getBoundingClientRect().height) };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { rows: 0, transcripts: document.querySelectorAll('.transcript').length };
  })()`);
  if (!(ready as { rows?: number })?.rows) {
    const dom = await window.webContents.executeJavaScript(`(() => ({
      tabs: document.querySelectorAll('.workspace-tab').length,
      composer: document.querySelectorAll('.composer').length,
      sidebar: document.querySelectorAll('.session-sidebar').length,
      create: document.querySelectorAll('.session-new-task').length,
      rail: document.querySelectorAll('.activity-rail').length,
      newTask: document.querySelectorAll('button[aria-label="New task"]').length,
      panes: document.querySelectorAll('[data-pane-id]').length,
      text: (document.body.innerText || '').slice(0, 200).replace(/\\s+/g, ' '),
    }))()`);
    throw new Error(`width probe: transcript never rendered ${JSON.stringify(ready)} dom=${JSON.stringify(dom)}`);
  }
  const install = WIDTH_TRACE_INSTALL_SCRIPT;
  const sweep = async (label: string, prepare: string) => {
    await window.webContents.executeJavaScript(prepare);
    await sleep(400);
    const setup = await window.webContents.executeJavaScript(install);
    const bounds = window.getBounds();
    const narrowWidth = 489;
    // A real drag delivers a new width almost every frame: step in small
    // increments so the rewrap path is exercised the way a pointer does it.
    // 1920 -> 489 crosses the 2xl/md frame boundaries and the narrow
    // working-pane range from the user report. The physical sash pass below
    // continues down to the 324px pane floor.
    for (let width = bounds.width; width >= narrowWidth; width -= 12) {
      window.setBounds({ ...bounds, width: Math.max(narrowWidth, width) });
      await sleep(30);
    }
    for (let width = narrowWidth; width <= bounds.width; width += 12) {
      window.setBounds({ ...bounds, width: Math.min(bounds.width, width) });
      await sleep(30);
    }
    window.setBounds(bounds);
    await sleep(400);
    const report = await window.webContents.executeJavaScript(WIDTH_TRACE_COLLECT_SCRIPT);
    return { label, setup, ...(report as Record<string, unknown>) };
  };
  const reading = await sweep(
    'reading',
    `(() => {
    const node = [...document.querySelectorAll('.transcript')]
      .find((candidate) => candidate.getBoundingClientRect().height > 0);
    node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }));
    node.scrollTop = Math.round((node.scrollHeight - node.clientHeight) * 0.5);
    node.dispatchEvent(new Event('scroll', { bubbles: true }));
    return true;
  })()`
  );
  const following = await sweep(
    'following',
    `(() => {
    const node = [...document.querySelectorAll('.transcript')]
      .find((candidate) => candidate.getBoundingClientRect().height > 0
        && candidate.querySelectorAll('.transcript-virtual-row').length > 3);
    const jump = document.querySelector('.jump-to-latest');
    if (jump instanceof HTMLElement) jump.click();
    node.scrollTop = node.scrollHeight - node.clientHeight;
    node.dispatchEvent(new Event('scroll', { bubbles: true }));
    return true;
  })()`
  );
  // Create a real row split through the product shortcut, then drive its
  // physical resize handle with Electron input events. This crosses the
  // md frame/inset boundary in both directions without changing the
  // window, so window media queries cannot hide pane-owned width defects.
  // The split needs enough physical range for one pane to cross both 768px
  // and the 800px centered-frame cap while preserving the sibling's 320px
  // floor. The normal 1280px capture window leaves only ~284px of sash
  // travel, so widen the probe host before creating the split.
  window.setBounds({ ...window.getBounds(), width: 1_920, height: 900 });
  await sleep(600);
  window.webContents.sendInputEvent({
    type: 'keyDown',
    keyCode: '\\',
    modifiers: ['control'],
  });
  window.webContents.sendInputEvent({
    type: 'keyUp',
    keyCode: '\\',
    modifiers: ['control'],
  });
  await sleep(800);
  const initialSash = await readProbeSash(window);
  if (!initialSash || initialSash.maxX - initialSash.minX < 480) {
    throw new Error(`width probe: real pane sash unavailable ${JSON.stringify(initialSash)}`);
  }
  const dragSash = () => dragProbeSash(window, initialSash, sleep);
  const sashSweep = async (label: string, prepare: string) => {
    await window.webContents.executeJavaScript(prepare);
    await sleep(400);
    const setup = await window.webContents.executeJavaScript(install);
    await dragSash();
    const report = await window.webContents.executeJavaScript(WIDTH_TRACE_COLLECT_SCRIPT);
    return { label, setup, ...(report as Record<string, unknown>) };
  };
  const sashReading = await sashSweep(
    'sash-reading',
    `(() => {
    const node = [...document.querySelectorAll('.transcript')]
      .find((candidate) => candidate.getBoundingClientRect().height > 0
        && candidate.querySelectorAll('.transcript-virtual-row').length > 3);
    node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }));
    node.scrollTop = Math.round((node.scrollHeight - node.clientHeight) * 0.5);
    node.dispatchEvent(new Event('scroll', { bubbles: true }));
    return true;
  })()`
  );
  const sashFollowing = await sashSweep(
    'sash-following',
    `(() => {
    const node = [...document.querySelectorAll('.transcript')]
      .find((candidate) => candidate.getBoundingClientRect().height > 0
        && candidate.querySelectorAll('.transcript-virtual-row').length > 3);
    const jump = node.closest('.conversation')?.querySelector('.jump-to-latest');
    if (jump instanceof HTMLElement) jump.click();
    node.scrollTop = node.scrollHeight - node.clientHeight;
    node.dispatchEvent(new Event('scroll', { bubbles: true }));
    return true;
  })()`
  );
  const summary = {
    widthSweeps: [reading, following],
    sashSweeps: [sashReading, sashFollowing],
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ summary }, null, 1));
  console.log(`[jitter-probe] ${JSON.stringify(summary)}`);
  const followReports = [following, sashFollowing].map((report) => report as unknown as Record<string, unknown>);
  const unstableFollow = followReports.filter((report) => {
    const sash = String(report.label).startsWith('sash-');
    const writes = Number(report.writes);
    const reversals = Number(report.scrollReversals);
    const writeStacks = Array.isArray(report.writeStacks) ? report.writeStacks.map(String) : [];
    // The content observer may resolve the discrete 768px row-inset
    // reflow with ONE pin per crossing, and the down-then-up window sweep
    // crosses that breakpoint twice. The pin lands in the same pre-paint
    // ResizeObserver transaction, so no frame ever shows the gap. A physical
    // pane drag has no viewport breakpoint, so it must remain entirely
    // write-free. More writes, another reversal, or any non-observer writer
    // means two scroll authorities are competing.
    const stableWrites = sash
      ? writes === 0 && reversals === 0
      : (writes === 0 && reversals === 0) ||
        (writes <= 2 &&
          // Each observer write can yield two sampled direction changes:
          // pre-write → requested scrollHeight → Chromium-clamped bottom.
          reversals <= 2 * writes &&
          writeStacks.length === 1 &&
          writeStacks[0].includes('ResizeObserver.'));
    return (
      !stableWrites ||
      Number(report.maxNarrowBottomDistance) > 2 ||
      // The window sweep crosses the discrete 768px row-inset transition.
      // The content transaction may expose its one-way 24px rewrap for one
      // frame, but the actual pane drag and reported <=520px range stay strict.
      Number(report.maxBottomDistance) > (sash ? 2 : 24)
    );
  });
  if (unstableFollow.length > 0) {
    throw new Error(`width probe: active follow unstable ${JSON.stringify(unstableFollow)}`);
  }
  return { reversals: 0 } as { reversals: number };
}
