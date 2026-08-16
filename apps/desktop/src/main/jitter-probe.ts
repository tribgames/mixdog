/**
 * Transcript scroll-jitter probe (MIXDOG_JITTER_PROBE=1 through the capture
 * window): reproduces "enter a long session that is STILL STREAMING" and
 * measures per-frame bottom stability of the followed transcript.
 *
 * Output: artifacts/jitter-probe.json — per-frame samples plus summary
 * metrics. The interesting number is `reversals`: frames where the tail row
 * moved UP then DOWN (or vice versa) beyond the threshold while the view was
 * supposed to be pinned to the bottom. A stable follow has ~0 reversals and
 * a bottom distance that stays near 0 the whole time.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import type { BrowserWindow } from 'electron';
import {
  assistantMarkdown,
  coldHistoryItems,
  paragraph,
  probeItems,
} from './jitter-probe-fixtures';
import {
  beginPaintFrameProbe,
  contentMotion,
  summarizeWarmPaint,
  type PaintProbeBounds,
  type PaintFrameSample,
  type RowSample,
} from './jitter-probe-metrics';
import {
  WIDTH_TRACE_COLLECT_SCRIPT,
  WIDTH_TRACE_INSTALL_SCRIPT,
} from './jitter-probe-width-scripts';
import { dragProbeSash, readProbeSash } from './jitter-probe-sash';
import {
  clickProbeSession,
  COLLECT_SWITCH_FRAMES_SCRIPT,
} from './jitter-probe-session';

interface ProbeDeps {
  window: BrowserWindow;
  stateChannel: string;
  baseSnapshot: Record<string, unknown>;
  prepareRemoteResume(
    stored: Record<string, unknown>,
    live: Record<string, unknown>,
  ): void;
  prepareColdResume(snapshot: Record<string, unknown>): void;
  outPath: string;
}

export async function runJitterProbe({
  window,
  stateChannel,
  baseSnapshot,
  prepareRemoteResume,
  prepareColdResume,
  outPath,
}: ProbeDeps): Promise<{ reversals: number }> {
  const send = (state: Record<string, unknown>) => {
    window.webContents.send(stateChannel, state);
  };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  // MIXDOG_JITTER_PROBE=entry runs ONLY the cold-entry/tool-toggle pass, so
  // the streaming pass keeps its pristine (never-visited) starting state.
  const entryMode = process.env.MIXDOG_JITTER_PROBE === 'entry';
  // MIXDOG_JITTER_PROBE=keys runs ONLY the keyboard-paging pass.
  const keysMode = process.env.MIXDOG_JITTER_PROBE === 'keys';
  // MIXDOG_JITTER_PROBE=switch runs rapid A→B→C switching plus both side
  // panels' named View Transition handover checks.
  const switchMode = process.env.MIXDOG_JITTER_PROBE === 'switch';
  // MIXDOG_JITTER_PROBE=width measures a REAL window-width drag: who writes
  // scrollTop, and how far the reader's row moves per rewrap step.
  const widthMode = process.env.MIXDOG_JITTER_PROBE === 'width';
  if (entryMode) {
    await window.webContents.executeJavaScript(
      'window.__mixdogMarkdownPreloadDelayMs = 1200; true',
    );
  }

  // The workspace renders the ACTIVE TAB's route; open a task tab first (same
  // precondition as the tool-showcase pass) so pushed snapshots hit the
  // visible transcript.
  await window.webContents.executeJavaScript(`(async () => {
    const started = Date.now();
    // Class selectors only: aria-labels are localized, so an English label
    // silently stops finding the entry in a Korean UI.
    const find = () => document.querySelector('.session-new-task')
      || document.querySelector('button[aria-label="New task"]');
    let link = null;
    while (Date.now() - started < 5_000) {
      link = find();
      if (link instanceof HTMLElement) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // New Task is the Sessions header "+" itself: open the panel and reach
    // for the entry again.
    if (!(link instanceof HTMLElement)) {
      const sidebar = document.querySelector('.toolbar-sidebar');
      if (sidebar instanceof HTMLElement) {
        sidebar.click();
        await new Promise((resolve) => setTimeout(resolve, 200));
        link = find();
      }
    }
    if (link instanceof HTMLElement) link.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    return Boolean(document.querySelector('.composer'));
  })()`);

  if (widthMode) {
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
        rail: document.querySelectorAll('.toolbar-sidebar').length,
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
    const reading = await sweep('reading', `(() => {
      const node = [...document.querySelectorAll('.transcript')]
        .find((candidate) => candidate.getBoundingClientRect().height > 0);
      node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }));
      node.scrollTop = Math.round((node.scrollHeight - node.clientHeight) * 0.5);
      node.dispatchEvent(new Event('scroll', { bubbles: true }));
      return true;
    })()`);
    const following = await sweep('following', `(() => {
      const node = [...document.querySelectorAll('.transcript')]
        .find((candidate) => candidate.getBoundingClientRect().height > 0
          && candidate.querySelectorAll('.transcript-virtual-row').length > 3);
      const jump = document.querySelector('.jump-to-latest');
      if (jump instanceof HTMLElement) jump.click();
      node.scrollTop = node.scrollHeight - node.clientHeight;
      node.dispatchEvent(new Event('scroll', { bubbles: true }));
      return true;
    })()`);
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
    const sashReading = await sashSweep('sash-reading', `(() => {
      const node = [...document.querySelectorAll('.transcript')]
        .find((candidate) => candidate.getBoundingClientRect().height > 0
          && candidate.querySelectorAll('.transcript-virtual-row').length > 3);
      node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }));
      node.scrollTop = Math.round((node.scrollHeight - node.clientHeight) * 0.5);
      node.dispatchEvent(new Event('scroll', { bubbles: true }));
      return true;
    })()`);
    const sashFollowing = await sashSweep('sash-following', `(() => {
      const node = [...document.querySelectorAll('.transcript')]
        .find((candidate) => candidate.getBoundingClientRect().height > 0
          && candidate.querySelectorAll('.transcript-virtual-row').length > 3);
      const jump = node.closest('.conversation')?.querySelector('.jump-to-latest');
      if (jump instanceof HTMLElement) jump.click();
      node.scrollTop = node.scrollHeight - node.clientHeight;
      node.dispatchEvent(new Event('scroll', { bubbles: true }));
      return true;
    })()`);
    const summary = {
      widthSweeps: [reading, following],
      sashSweeps: [sashReading, sashFollowing],
    };
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({ summary }, null, 1));
    console.log(`[jitter-probe] ${JSON.stringify(summary)}`);
    const followReports = [following, sashFollowing]
      .map((report) => report as unknown as Record<string, unknown>);
    const unstableFollow = followReports.filter((report) => {
      const sash = String(report.label).startsWith('sash-');
      const writes = Number(report.writes);
      const reversals = Number(report.scrollReversals);
      const writeStacks = Array.isArray(report.writeStacks)
        ? report.writeStacks.map(String)
        : [];
      // The content observer may resolve the discrete 768px row-inset
      // reflow with ONE pin per crossing, and the down-then-up window sweep
      // crosses that breakpoint twice. The pin lands in the same pre-paint
      // ResizeObserver transaction, so no frame ever shows the gap. A physical
      // pane drag has no viewport breakpoint, so it must remain entirely
      // write-free. More writes, another reversal, or any non-observer writer
      // means two scroll authorities are competing.
      const stableWrites = sash
        ? writes === 0 && reversals === 0
        : (writes === 0 && reversals === 0)
          || (writes <= 2
            // Each observer write can yield two sampled direction changes:
            // pre-write → requested scrollHeight → Chromium-clamped bottom.
            && reversals <= 2 * writes
            && writeStacks.length === 1
            && writeStacks[0].includes('ResizeObserver.'));
      return !stableWrites
        || Number(report.maxNarrowBottomDistance) > 2
        // The window sweep crosses the discrete 768px row-inset transition.
        // The content transaction may expose its one-way 24px rewrap for one
        // frame, but the actual pane drag and reported <=520px range stay strict.
        || Number(report.maxBottomDistance) > (sash ? 2 : 24);
    });
    if (unstableFollow.length > 0) {
      throw new Error(`width probe: active follow unstable ${JSON.stringify(unstableFollow)}`);
    }
    return { reversals: 0 } as { reversals: number };
  }

  if (switchMode) {
    const clickSession = (id: string, waitMs: number) =>
      clickProbeSession(window, id, waitMs);
    // Warm B into the renderer snapshot cache, leave for A, then start a
    // delayed B resume and choose C before it settles. The old defect painted
    // cached B under C's title for up to 90ms.
    await clickSession('probe_switch_b', 320);
    await clickSession('probe_switch_a', 320);
    await window.webContents.executeJavaScript(`(() => {
      const w = window;
      w.__switchProbe = { frames: [], raf: 0 };
      const sample = () => {
        w.__switchProbe.frames.push({
          t: Math.round(performance.now()),
          title: document.querySelector('.session-header h1')?.textContent?.trim() || '',
          transcript: document.querySelector('.transcript')?.innerText || '',
        });
        w.__switchProbe.raf = requestAnimationFrame(sample);
      };
      w.__switchProbe.raf = requestAnimationFrame(sample);
      return true;
    })()`);
    await window.webContents.executeJavaScript(`(async () => {
      const b = document.querySelector('[data-session-id="probe_switch_b"]');
      const c = document.querySelector('[data-session-id="probe_switch_c"]');
      if (!(b instanceof HTMLElement) || !(c instanceof HTMLElement)) {
        throw new Error('Missing rapid switch probe rows');
      }
      b.click();
      await new Promise((resolve) => setTimeout(resolve, 24));
      c.click();
      await new Promise((resolve) => setTimeout(resolve, 700));
      return true;
    })()`);
    const switchFrames = await window.webContents.executeJavaScript(
      COLLECT_SWITCH_FRAMES_SCRIPT,
    ) as Array<{ t: number; title: string; transcript: string }>;
    const wrongSessionFrames = switchFrames.filter((frame) => {
      const title = /Switch ([ABC])/.exec(frame.title)?.[1] || '';
      const transcript = /Switch ([ABC]) transcript/.exec(frame.transcript)?.[1] || '';
      return Boolean(title && transcript && title !== transcript);
    });
    const finalSwitchFrame = switchFrames.at(-1);

    // Foreground session tabs share one viewport. Each session is first placed
    // at a different off-bottom anchor, then A↔B is repeated while counting
    // actual scroll writes. A route commit must expose its saved section in
    // one write and one frame — no index pre-scroll or pending retry.
    const foregroundScroll = await window.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const transcriptFor = (id) => [...document.querySelectorAll('.transcript')]
        .find((node) => node.getAttribute('data-session-key') === id
          && node.getBoundingClientRect().height > 0);
      const activate = async (id, waitMs = 320) => {
        const row = document.querySelector('[data-session-id="' + id + '"]');
        if (!(row instanceof HTMLElement)) throw new Error('Missing foreground scroll row: ' + id);
        row.click();
        await sleep(waitMs);
        const transcript = transcriptFor(id);
        if (!(transcript instanceof HTMLElement)) {
          throw new Error('Missing foreground transcript after activating ' + id);
        }
        return transcript;
      };
      const anchorFor = (transcript) => {
        const box = transcript.getBoundingClientRect();
        const rows = [...transcript.querySelectorAll('.transcript-virtual-row')]
          .map((row) => ({ row, box: row.getBoundingClientRect() }))
          .filter((entry) => entry.box.bottom > box.top && entry.box.top < box.bottom)
          .sort((left, right) => left.box.top - right.box.top);
        const entry = rows[0];
        return entry ? {
          index: entry.row.getAttribute('data-index') || '',
          text: (entry.row.textContent || '').replace(/\s+/g, '').slice(0, 120),
          offset: entry.box.top - box.top,
        } : null;
      };
      const place = async (id, ratio) => {
        const transcript = await activate(id);
        transcript.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true, cancelable: true, deltaY: -120,
        }));
        transcript.scrollTop = Math.round(
          Math.max(0, transcript.scrollHeight - transcript.clientHeight) * ratio,
        );
        transcript.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await sleep(60);
        return {
          scrollTop: transcript.scrollTop,
          anchor: anchorFor(transcript),
        };
      };

      const baseline = {
        probe_switch_a: await place('probe_switch_a', 0.38),
        probe_switch_b: await place('probe_switch_b', 0.62),
      };
      const viewport = transcriptFor('probe_switch_b');
      if (!(viewport instanceof HTMLElement)) throw new Error('Missing shared foreground viewport');
      const writes = [];
      const nativeScrollTo = viewport.scrollTo.bind(viewport);
      viewport.scrollTo = (...args) => {
        const value = typeof args[0] === 'object' ? Number(args[0]?.top) : Number(args[1]);
        writes.push({
          t: performance.now(),
          top: value,
          sessionKey: viewport.getAttribute('data-session-key') || '',
        });
        return nativeScrollTo(...args);
      };
      const switches = [];
      for (let index = 0; index < 20; index += 1) {
        const id = index % 2 === 0 ? 'probe_switch_a' : 'probe_switch_b';
        const beforeWrites = writes.length;
        const frames = [];
        let raf = 0;
        const sample = () => {
          const transcript = transcriptFor(id);
          frames.push({
            t: performance.now(),
            sessionKey: transcript?.getAttribute('data-session-key') || '',
            scrollTop: transcript instanceof HTMLElement ? transcript.scrollTop : null,
            anchor: transcript instanceof HTMLElement ? anchorFor(transcript) : null,
          });
          raf = requestAnimationFrame(sample);
        };
        raf = requestAnimationFrame(sample);
        const transcript = await activate(id);
        cancelAnimationFrame(raf);
        const finalAnchor = anchorFor(transcript);
        const expected = baseline[id];
        const targetFrames = frames.filter((frame) => frame.sessionKey === id);
        switches.push({
          id,
          writes: writes.slice(beforeWrites).filter((entry) => entry.sessionKey === id).length,
          totalWrites: writes.length - beforeWrites,
          writeTops: writes.slice(beforeWrites).map((entry) =>
            entry.sessionKey + ':' + entry.top),
          finalScrollTop: transcript.scrollTop,
          scrollDrift: Math.abs(transcript.scrollTop - expected.scrollTop),
          anchorText: finalAnchor?.text || '',
          anchorTextMatches: finalAnchor?.text === expected.anchor?.text,
          anchorOffsetDrift: finalAnchor && expected.anchor
            ? Math.abs(finalAnchor.offset - expected.anchor.offset)
            : Number.POSITIVE_INFINITY,
          frameScrollDrift: targetFrames.reduce((maximum, frame) =>
            frame.scrollTop === null
              ? maximum
              : Math.max(maximum, Math.abs(frame.scrollTop - expected.scrollTop)), 0),
          missingAnchorFrames: targetFrames.filter((frame) => !frame.anchor).length,
          frames: targetFrames,
        });
      }
      return {
        baseline,
        switches,
        maxWrites: Math.max(...switches.map((entry) => entry.writes)),
        maxTotalWrites: Math.max(...switches.map((entry) => entry.totalWrites)),
        maxScrollDrift: Math.max(...switches.map((entry) => entry.scrollDrift)),
        maxFrameScrollDrift: Math.max(...switches.map((entry) => entry.frameScrollDrift)),
        maxAnchorOffsetDrift: Math.max(...switches.map((entry) => entry.anchorOffsetDrift)),
        missingAnchorFrames: switches.reduce(
          (total, entry) => total + entry.missingAnchorFrames, 0),
        anchorMismatchCount: switches.filter((entry) => !entry.anchorTextMatches).length,
      };
    })()`) as {
      baseline: Record<string, unknown>;
      switches: unknown[];
      maxWrites: number;
      maxTotalWrites: number;
      maxScrollDrift: number;
      maxFrameScrollDrift: number;
      maxAnchorOffsetDrift: number;
      missingAnchorFrames: number;
      anchorMismatchCount: number;
    };

    // Warm New Task → long session re-entry is the path that used to pass DOM
    // identity/geometry tests while still flashing during compositor raster
    // upload. Measure both the DOM frame sequence and the actual presented
    // pixels from the click, without the streaming probe's entry exclusion.
    await clickSession('probe_switch_b', 900);
    const warmSetup = await window.webContents.executeJavaScript(`(async () => {
      const visibleTranscript = () => [...document.querySelectorAll('.transcript')]
        .find((node) => node.getBoundingClientRect().height > 0);
      const transcript = visibleTranscript();
      if (!(transcript instanceof HTMLElement)) throw new Error('Missing warm re-entry transcript');
      transcript.scrollTop = Math.max(0, transcript.scrollHeight - transcript.clientHeight - 1_800);
      transcript.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const started = performance.now();
      let script = null;
      while (performance.now() - started < 2_000) {
        const box = transcript.getBoundingClientRect();
        const candidates = [...transcript.querySelectorAll(
          '.transcript-virtual-row .markdown-code',
        )];
        script = candidates.find((candidate) => {
          const rect = candidate.getBoundingClientRect();
          return rect.bottom > box.top && rect.top < box.bottom;
        }) || candidates[0] || null;
        if (script instanceof HTMLElement) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!(script instanceof HTMLElement)) throw new Error('Missing warm re-entry script');
      const scriptRow = script.closest('.transcript-virtual-row');
      if (!(scriptRow instanceof HTMLElement)) {
        throw new Error('Missing warm re-entry script row');
      }
      const rowIndex = scriptRow.getAttribute('data-index');
      const conversation = transcript.closest('.conversation');
      const preflight = {
        scriptConnected: script.isConnected,
        rowConnected: scriptRow.isConnected,
        rowIndex,
      };
      const samples = [];
      const shifts = [];
      let observer = null;
      try {
        observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            shifts.push({ t: entry.startTime, value: entry.value, recent: entry.hadRecentInput });
          }
        });
        observer.observe({ type: 'layout-shift', buffered: true });
      } catch {}
      const probe = {
        script,
        scriptRow,
        rowIndex,
        conversation,
        samples,
        shifts,
        returnAt: Number.POSITIVE_INFINITY,
        raf: 0,
        observer,
      };
      const sample = () => {
        const current = visibleTranscript();
        const space = current?.querySelector('.transcript-virtual-space');
        // The timeline is rebuilt per session from its measured snapshot, so
        // the contract is the SAME ROW returning to the same place, not the
        // same DOM node surviving the round trip.
        const row = current
          ? [...current.querySelectorAll('.transcript-virtual-row')]
            .find((candidate) => candidate.getAttribute('data-index') === rowIndex)
          : null;
        const currentScript = row?.querySelector('.markdown-code') || null;
        samples.push({
          t: performance.now(),
          sessionKey: current?.getAttribute('data-session-key') || '',
          scrollTop: current instanceof HTMLElement ? current.scrollTop : null,
          scrollHeight: current instanceof HTMLElement ? current.scrollHeight : null,
          spaceHeight: space?.getBoundingClientRect().height ?? null,
          scriptTop: currentScript ? currentScript.getBoundingClientRect().top : null,
          conversationSame: current?.closest('.conversation') === conversation,
          rowSame: Boolean(row),
          replacementScript: Boolean(current?.querySelector(
            '.transcript-virtual-row .markdown-code',
          )),
          scriptSame: Boolean(currentScript),
        });
        probe.raf = requestAnimationFrame(sample);
      };
      probe.raf = requestAnimationFrame(sample);
      window.__warmReentryProbe = probe;
      const rect = transcript.getBoundingClientRect();
      return {
        preflight,
        paintBounds: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        },
      };
    })()`) as {
      preflight: Record<string, unknown>;
      paintBounds: PaintProbeBounds;
    };
    const paintProbe = beginPaintFrameProbe(window, warmSetup.paintBounds);
    await sleep(80);
    paintProbe.mark('new-task');
    const parked = await window.webContents.executeJavaScript(`(async () => {
      const probe = window.__warmReentryProbe;
      const tabByText = (text) => [...document.querySelectorAll('.workspace-tab')]
        .find((tab) => (tab.textContent || '').toLowerCase().includes(text.toLowerCase()));
      const newTask = tabByText('New task');
      if (!(newTask instanceof HTMLElement)) {
        throw new Error('Missing warm re-entry workspace tabs');
      }
      newTask.querySelector('.workspace-tab-main')?.click();
      await new Promise((resolve) => setTimeout(resolve, 120));
      return {
        scriptConnected: probe.script.isConnected,
        rowConnected: probe.scriptRow.isConnected,
      };
    })()`) as Record<string, unknown>;
    paintProbe.mark('reentry');
    let warmResult: {
      frames: number;
      conversationSame: boolean;
      rowSame: boolean;
      replacementScriptFrames: number;
      scriptSame: boolean;
      maxScrollDrift: number;
      maxSpaceDrift: number;
      missingScriptFrames: number;
      layoutShift: number;
      handoffFrames: number;
      firstStableMs: number | null;
      samples: unknown[];
    };
    let paintFrames: PaintFrameSample[];
    try {
      warmResult = await window.webContents.executeJavaScript(`(async () => {
      const probe = window.__warmReentryProbe;
      const visibleTranscript = () => [...document.querySelectorAll('.transcript')]
        .find((node) => node.getBoundingClientRect().height > 0);
      const tabByText = (text) => [...document.querySelectorAll('.workspace-tab')]
        .find((tab) => (tab.textContent || '').toLowerCase().includes(text.toLowerCase()));
      const longSession = tabByText('Switch B');
      if (!(longSession instanceof HTMLElement)) {
        throw new Error('Missing warm re-entry session tab');
      }
      probe.returnAt = performance.now();
      longSession.querySelector('.workspace-tab-main')?.click();
      await new Promise((resolve) => setTimeout(resolve, 700));
      cancelAnimationFrame(probe.raf);
      probe.observer?.disconnect();
      const afterReturn = probe.samples.filter((sample) => sample.t >= probe.returnAt);
      const post = afterReturn.filter((sample) => sample.sessionKey === 'probe_switch_b');
      const range = (values) => values.length
        ? Math.max(...values) - Math.min(...values)
        : Number.POSITIVE_INFINITY;
      const firstStable = afterReturn.find((sample) =>
        sample.sessionKey === 'probe_switch_b'
        && sample.scriptSame
        && sample.scrollTop !== null
        && sample.spaceHeight !== null);
      const firstTargetIndex = afterReturn.findIndex(
        (sample) => sample.sessionKey === 'probe_switch_b',
      );
      return {
        frames: post.length,
        conversationSame: post.every((sample) => sample.conversationSame),
        rowSame: post.some((sample) => sample.rowSame)
          && post.every((sample) => sample.rowSame),
        replacementScriptFrames: post.filter((sample) => sample.replacementScript).length,
        scriptSame: post.some((sample) => sample.scriptSame)
          && post.every((sample) => sample.scriptSame),
        maxScrollDrift: range(post.map((sample) => sample.scrollTop)
          .filter((value) => Number.isFinite(value))),
        maxSpaceDrift: range(post.map((sample) => sample.spaceHeight)
          .filter((value) => Number.isFinite(value))),
        missingScriptFrames: post.filter((sample) => sample.scriptTop === null).length,
        layoutShift: probe.shifts.filter((entry) => entry.t >= probe.returnAt)
          .reduce((total, entry) => total + entry.value, 0),
        handoffFrames: firstTargetIndex < 0 ? Number.POSITIVE_INFINITY : firstTargetIndex,
        firstStableMs: firstStable ? firstStable.t - probe.returnAt : null,
        samples: probe.samples,
      };
      })()`) as typeof warmResult;
    } finally {
      paintFrames = paintProbe.stop();
    }
    const warmReentry = {
      ...warmResult!,
      preflight: warmSetup.preflight,
      parked,
      paint: summarizeWarmPaint(paintFrames!),
    };

    // Studio → long task must return to the exact same virtual section. Unlike
    // New Task, Studio is an opaque utility surface in the same pane; measure
    // the script row itself so a stable outer slot cannot hide row/cache drift.
    const studioReentry = await window.webContents.executeJavaScript(`(async () => {
      const visibleTranscript = () => [...document.querySelectorAll('.transcript')]
        .find((node) => node.getBoundingClientRect().height > 0);
      const transcript = visibleTranscript();
      if (!(transcript instanceof HTMLElement)) throw new Error('Missing Studio re-entry transcript');
      const scriptRow = [...transcript.querySelectorAll('.transcript-virtual-row')]
        .find((row) => row.querySelector('.markdown-code'));
      const script = scriptRow?.querySelector('.markdown-code');
      if (!(scriptRow instanceof HTMLElement) || !(script instanceof HTMLElement)) {
        throw new Error('Missing Studio re-entry script row');
      }
      const transcriptBox = transcript.getBoundingClientRect();
      const rowBox = scriptRow.getBoundingClientRect();
      transcript.scrollTop = Math.max(0, transcript.scrollTop + rowBox.top - transcriptBox.top + 96);
      transcript.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rowIndex = scriptRow.getAttribute('data-index') || '';
      const conversation = transcript.closest('.conversation');
      const baselineRowHeight = scriptRow.getBoundingClientRect().height;
      const baselineScriptHeight = script.getBoundingClientRect().height;
      const baselineScrollTop = transcript.scrollTop;
      const baselineSpaceHeight = transcript.querySelector('.transcript-virtual-space')
        ?.getBoundingClientRect().height ?? null;
      const probe = {
        transcript,
        conversation,
        scriptRow,
        script,
        rowIndex,
        baselineRowHeight,
        baselineScriptHeight,
        baselineScrollTop,
        baselineSpaceHeight,
        returnAt: Number.POSITIVE_INFINITY,
        samples: [],
        raf: 0,
      };
      const sample = () => {
        const current = visibleTranscript();
        const row = current
          ? [...current.querySelectorAll('.transcript-virtual-row')]
            .find((candidate) => candidate.getAttribute('data-index') === rowIndex
              && candidate.querySelector('.markdown-code'))
          : null;
        const currentScript = row?.querySelector('.markdown-code');
        probe.samples.push({
          t: performance.now(),
          sessionKey: current?.getAttribute('data-session-key') || '',
          scrollTop: current instanceof HTMLElement ? current.scrollTop : null,
          spaceHeight: current?.querySelector('.transcript-virtual-space')
            ?.getBoundingClientRect().height ?? null,
          rowHeight: row?.getBoundingClientRect().height ?? null,
          scriptHeight: currentScript?.getBoundingClientRect().height ?? null,
          conversationSame: current?.closest('.conversation') === conversation,
          rowSame: row === scriptRow,
          scriptSame: currentScript === script,
        });
        probe.raf = requestAnimationFrame(sample);
      };
      probe.raf = requestAnimationFrame(sample);
      window.__studioReentryProbe = probe;

      const newButton = document.querySelector('.workspace-tab-new');
      if (!(newButton instanceof HTMLElement)) throw new Error('Missing New tab button');
      newButton.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, button: 0, pointerId: 1,
      }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const studioItem = [...document.querySelectorAll('[role="menuitem"]')]
        .find((item) => (item.textContent || '').trim() === 'New Studio');
      if (!(studioItem instanceof HTMLElement)) throw new Error('Missing New Studio action');
      studioItem.click();
      await new Promise((resolve) => setTimeout(resolve, 180));
      const studioTab = [...document.querySelectorAll('.workspace-tab')]
        .find((tab) => (tab.textContent || '').trim() === 'Studio');
      if (!(studioTab instanceof HTMLElement) || !studioTab.classList.contains('active')) {
        throw new Error('Studio tab did not activate');
      }
      const longSession = [...document.querySelectorAll('.workspace-tab')]
        .find((tab) => (tab.textContent || '').includes('Switch B'));
      if (!(longSession instanceof HTMLElement)) throw new Error('Missing Switch B tab after Studio');
      probe.returnAt = performance.now();
      longSession.querySelector('.workspace-tab-main')?.click();
      await new Promise((resolve) => setTimeout(resolve, 700));
      cancelAnimationFrame(probe.raf);
      const post = probe.samples.filter((entry) =>
        entry.t >= probe.returnAt && entry.sessionKey === 'probe_switch_b');
      const range = (values) => values.length
        ? Math.max(...values) - Math.min(...values)
        : Number.POSITIVE_INFINITY;
      return {
        frames: post.length,
        baselineRowHeight,
        baselineScriptHeight,
        baselineScrollTop,
        baselineSpaceHeight,
        conversationSame: post.length > 0 && post.every((entry) => entry.conversationSame),
        rowSame: post.length > 0 && post.every((entry) => entry.rowSame),
        scriptSame: post.length > 0 && post.every((entry) => entry.scriptSame),
        missingRowFrames: post.filter((entry) => entry.rowHeight === null).length,
        maxRowHeightDrift: range(post.map((entry) => entry.rowHeight)
          .filter((value) => Number.isFinite(value)).concat([baselineRowHeight])),
        maxScriptHeightDrift: range(post.map((entry) => entry.scriptHeight)
          .filter((value) => Number.isFinite(value)).concat([baselineScriptHeight])),
        maxScrollDrift: range(post.map((entry) => entry.scrollTop)
          .filter((value) => Number.isFinite(value)).concat([baselineScrollTop])),
        maxSpaceDrift: range(post.map((entry) => entry.spaceHeight)
          .filter((value) => Number.isFinite(value)).concat(
            baselineSpaceHeight === null ? [] : [baselineSpaceHeight],
          )),
        samples: probe.samples,
      };
    })()`) as {
      frames: number;
      baselineRowHeight: number;
      baselineScriptHeight: number;
      baselineScrollTop: number;
      baselineSpaceHeight: number | null;
      conversationSame: boolean;
      rowSame: boolean;
      scriptSame: boolean;
      missingRowFrames: number;
      maxRowHeightDrift: number;
      maxScriptHeightDrift: number;
      maxScrollDrift: number;
      maxSpaceDrift: number;
      samples: unknown[];
    };

    const probePanelToggle = async (selector: string) => (
      window.webContents.executeJavaScript(`(async () => {
        const selector = ${JSON.stringify(selector)};
        const button = document.querySelector(selector);
        if (!(button instanceof HTMLElement)) throw new Error('Missing panel probe toggle: ' + selector);
        const w = window;
        const frames = [];
        let raf = 0;
        const sample = () => {
          const shell = document.querySelector('.app-shell');
          const workspace = document.querySelector('.workspace');
          const box = workspace?.getBoundingClientRect();
          const animations = document.getAnimations({ subtree: true }).filter((animation) => {
            const pseudo = String(animation.effect?.pseudoElement || '');
            return pseudo.includes('view-transition') || pseudo.includes('mx-side-panel');
          });
          frames.push({
            t: Math.round(performance.now()),
            phase: shell?.getAttribute('data-side-flip') || '',
            left: box ? Math.round(box.left) : null,
            width: box ? Math.round(box.width) : null,
            animations: animations.length,
          });
          raf = requestAnimationFrame(sample);
        };
        raf = requestAnimationFrame(sample);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 360));
        cancelAnimationFrame(raf);
        return frames;
      })()`) as Promise<Array<{
        t: number;
        phase: string;
        left: number | null;
        width: number | null;
        animations: number;
      }>>
    );
    const summarizePanel = (samples: Awaited<ReturnType<typeof probePanelToggle>>) => {
      const activeIndexes = samples
        .map((sample, index) => sample.phase ? index : -1)
        .filter((index) => index >= 0);
      const first = samples[0];
      const last = samples.at(-1);
      const lastActiveIndex = activeIndexes.at(-1) ?? -1;
      const anchor = lastActiveIndex >= 0 ? samples[lastActiveIndex] : null;
      const post = lastActiveIndex >= 0 ? samples.slice(lastActiveIndex + 1) : [];
      const delta = (sample: typeof first, other: typeof first) => Math.max(
        Math.abs(Number(sample.left) - Number(other.left)),
        Math.abs(Number(sample.width) - Number(other.width)),
      );
      return {
        phase: activeIndexes.length ? samples[activeIndexes[0]].phase : '',
        activeFrames: activeIndexes.length,
        animatedFrames: samples.filter((sample) => sample.phase && sample.animations > 0).length,
        geometryDelta: first && last ? delta(first, last) : 0,
        postHandoverShift: anchor && post.length
          ? Math.max(...post.map((sample) => delta(anchor, sample)))
          : 0,
      };
    };
    const panels = [];
    for (const selector of [
      '.session-header-menu',
      '.session-header-menu',
      '.toolbar-dock[aria-label$="utility panel"]',
      '.toolbar-dock[aria-label$="utility panel"]',
    ]) {
      panels.push(summarizePanel(await probePanelToggle(selector)));
    }
    const switchSummary = {
      frames: switchFrames.length,
      wrongSessionFrames: wrongSessionFrames.length,
      finalTitle: finalSwitchFrame?.title || '',
      finalTranscript: finalSwitchFrame?.transcript || '',
      foregroundScroll,
      warmReentry,
      studioReentry,
      panels,
    };
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({ summary: switchSummary, switchFrames }, null, 1));
    console.log(`[jitter-probe] ${JSON.stringify(switchSummary)}`);
    const panelsPass = panels.every((panel) =>
      panel.geometryDelta >= 20
      && panel.postHandoverShift <= 1);
    if (wrongSessionFrames.length > 0
      || finalSwitchFrame?.title !== 'Switch C'
      || !finalSwitchFrame?.transcript.includes('Switch C transcript')
      || foregroundScroll.maxWrites > 1
      || foregroundScroll.maxTotalWrites > 1
      || foregroundScroll.maxScrollDrift > 1
      || foregroundScroll.maxFrameScrollDrift > 1
      || foregroundScroll.maxAnchorOffsetDrift > 1
      || foregroundScroll.missingAnchorFrames > 0
      || foregroundScroll.anchorMismatchCount > 0
      || warmReentry.frames < 10
      || !warmReentry.conversationSame
      || !warmReentry.scriptSame
      || warmReentry.maxScrollDrift > 1
      || warmReentry.maxSpaceDrift > 1
      || warmReentry.missingScriptFrames > 0
      || warmReentry.layoutShift > 0.001
      || warmReentry.handoffFrames > 1
      || warmReentry.firstStableMs === null
      || warmReentry.firstStableMs > 50
      // Frame subscription reports presentation changes, not idle vsyncs:
      // each static baseline legitimately contributes one compositor frame.
      || warmReentry.paint.sessionFrames < 1
      || warmReentry.paint.newTaskFrames < 1
      || warmReentry.paint.reentryFrames < 2
      || warmReentry.paint.maxBrightnessExcursion > 0.06
      || warmReentry.paint.firstStablePaintFrame === null
      || warmReentry.paint.firstStablePaintFrame > 3
      || studioReentry.frames < 10
      || !studioReentry.conversationSame
      || !studioReentry.rowSame
      || !studioReentry.scriptSame
      || studioReentry.missingRowFrames > 0
      || studioReentry.maxRowHeightDrift > 1
      || studioReentry.maxScriptHeightDrift > 1
      || studioReentry.maxScrollDrift > 1
      || studioReentry.maxSpaceDrift > 1
      || !panelsPass) {
      throw new Error(`Switch/panel jitter probe failed: ${JSON.stringify(switchSummary)}`);
    }
    return { reversals: 0, ...switchSummary } as unknown as { reversals: number };
  }

  // ── Keyboard paging pass ────────────────────────────────────────────────
  // Space / PageDown at the TOP of a long transcript must move the view down
  // and LEAVE it there. Chrome's own key scrolling animates the container
  // while the virtualizer still holds the pre-key offset, and the following
  // anchor correction used to snap the view straight back up (user report:
  // 최상단에서 스페이스를 누르면 내려갔다가 다시 위로 복귀).
  if (keysMode) {
    const keysStamp = Date.now() % 100_000;
    const keysSnapshot = {
      ...baseSnapshot,
      toasts: [],
      sessionId: 'probe_session_cold',
      busy: false,
      spinner: null,
      items: coldHistoryItems(120, keysStamp),
      streamingTail: null,
    };
    prepareColdResume(keysSnapshot);
    await window.webContents.executeJavaScript(`(async () => {
      const row = document.querySelector('[data-session-id="probe_session_cold"]');
      if (!(row instanceof HTMLElement)) throw new Error('Missing cold probe session row');
      row.click();
      await new Promise((resolve) => setTimeout(resolve, 600));
      return true;
    })()`);
    send(keysSnapshot);
    await sleep(2_500);
    const pickKeysTranscript = `(() => {
      const nodes = [...document.querySelectorAll('.transcript')]
        .filter((node) => node.getBoundingClientRect().height > 0);
      if (nodes.length === 0) return null;
      return nodes.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    })()`;
    const press = async (label: string, key: string, focusExpression = `${pickKeysTranscript}`) => {
      const before = await window.webContents.executeJavaScript(`(() => {
        const el = ${pickKeysTranscript};
        if (!el) return null;
        const focusTarget = ${focusExpression};
        if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus();
        const w = window;
        if (w.__keys && w.__keys.raf) cancelAnimationFrame(w.__keys.raf);
        w.__keys = { samples: [], raf: 0 };
        const sample = () => {
          w.__keys.samples.push({ t: Math.round(performance.now()), st: Math.round(el.scrollTop) });
          w.__keys.raf = requestAnimationFrame(sample);
        };
        w.__keys.raf = requestAnimationFrame(sample);
        return {
          scrollTop: Math.round(el.scrollTop),
          scrollHeight: Math.round(el.scrollHeight),
          clientHeight: Math.round(el.clientHeight),
          focused: document.activeElement === el,
          activeElement: String(document.activeElement?.className || document.activeElement?.tagName || ''),
        };
      })()`) as {
        scrollTop: number;
        scrollHeight: number;
        clientHeight: number;
        focused: boolean;
        activeElement: string;
      } | null;
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
      // Blink triggers the space-bar page scroll from the CHAR (keypress)
      // event, not keydown — a keyDown/keyUp-only pair scrolls nothing.
      if (key === 'Space') window.webContents.sendInputEvent({ type: 'char', keyCode: ' ' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
      await sleep(1_200);
      const samples = await window.webContents.executeJavaScript(`(() => {
        const w = window;
        cancelAnimationFrame(w.__keys.raf);
        w.__keys.raf = 0;
        return w.__keys.samples;
      })()`) as Array<{ t: number; st: number }>;
      const tops = samples.map((sample) => sample.st);
      const peak = tops.length ? Math.max(...tops) : 0;
      const settled = tops.length ? tops[tops.length - 1] : 0;
      return {
        label,
        key,
        before: before?.scrollTop ?? null,
        focused: before?.focused ?? false,
        activeElement: before?.activeElement ?? '',
        clientHeight: before?.clientHeight ?? 0,
        peak,
        settled,
        moved: settled - (before?.scrollTop ?? 0),
        // The reported signature: the view paged down and then returned.
        snapBack: peak - settled,
        samples,
      };
    };
    // Precondition: parked at the very top with follow disarmed.
    await window.webContents.executeJavaScript(`(async () => {
      const el = ${pickKeysTranscript};
      if (!el) return false;
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
      el.scrollTop = 0;
      await new Promise((resolve) => setTimeout(resolve, 500));
      el.scrollTop = 0;
      await new Promise((resolve) => setTimeout(resolve, 400));
      return true;
    })()`);
    const spaceFromTop = await press('space-from-top', 'Space');
    const spaceAgain = await press('space-again', 'Space');
    const pageDown = await press('pagedown', 'PageDown');
    // Real reading position: the user is parked ABOVE the live tail while the
    // turn is still streaming. Every stream tick re-renders the virtualizer,
    // which re-anchors the scroll offset — the suspected fight with Chrome's
    // own animated key scrolling.
    let streamTail = assistantMarkdown(97);
    let streaming = true;
    const streamItems = coldHistoryItems(120, keysStamp);
    const streamPump = (async () => {
      let tick = 0;
      while (streaming) {
        await sleep(66);
        tick += 1;
        streamTail += ` ${paragraph(400 + tick, 1)}`;
        if (tick % 5 === 0) streamTail += '\n\n';
        send({
          ...keysSnapshot,
          busy: true,
          spinner: { label: 'Working' },
          items: streamItems,
          streamingTail: { id: 'probe-keys-tail', kind: 'assistant', text: streamTail, streaming: true },
        });
      }
    })();
    await sleep(600);
    await window.webContents.executeJavaScript(`(async () => {
      const el = ${pickKeysTranscript};
      if (!el) return false;
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
      el.scrollTop = 0;
      await new Promise((resolve) => setTimeout(resolve, 400));
      el.scrollTop = 0;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return true;
    })()`);
    const spaceStreaming = await press('space-streaming', 'Space');
    const spaceStreamingAgain = await press('space-streaming-again', 'Space');
    // Focus variants at the SAME reading position: the real window usually
    // keeps the composer focused, and a clicked tool card leaves a button
    // focused inside the transcript.
    await window.webContents.executeJavaScript(`(async () => {
      const el = ${pickKeysTranscript};
      if (!el) return false;
      el.scrollTop = 0;
      await new Promise((resolve) => setTimeout(resolve, 400));
      return true;
    })()`);
    const spaceComposer = await press(
      'space-composer-focus',
      'Space',
      `document.querySelector('.composer textarea, .composer-region textarea, textarea')`,
    );
    await window.webContents.executeJavaScript(`(async () => {
      const el = ${pickKeysTranscript};
      if (!el) return false;
      el.scrollTop = 0;
      await new Promise((resolve) => setTimeout(resolve, 400));
      return true;
    })()`);
    const spaceToolHeader = await press(
      'space-tool-header-focus',
      'Space',
      `(() => {
        const el = ${pickKeysTranscript};
        if (!el) return null;
        const box = el.getBoundingClientRect();
        return [...el.querySelectorAll('.tool-card .tool-header')]
          .find((node) => {
            const rect = node.getBoundingClientRect();
            return rect.top >= box.top && rect.bottom <= box.bottom;
          }) || null;
      })()`,
    );
    streaming = false;
    await streamPump;
    const strip = (pass: Awaited<ReturnType<typeof press>>) => {
      const { samples: _samples, ...rest } = pass;
      return rest;
    };
    const keysSummary = {
      spaceFromTop: strip(spaceFromTop),
      spaceAgain: strip(spaceAgain),
      pageDown: strip(pageDown),
      spaceStreaming: strip(spaceStreaming),
      spaceStreamingAgain: strip(spaceStreamingAgain),
      spaceComposer: strip(spaceComposer),
      spaceToolHeader: strip(spaceToolHeader),
    };
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({
      summary: keysSummary,
      keySamples: {
        spaceFromTop: spaceFromTop.samples,
        spaceAgain: spaceAgain.samples,
        pageDown: pageDown.samples,
        spaceStreaming: spaceStreaming.samples,
        spaceStreamingAgain: spaceStreamingAgain.samples,
        spaceComposer: spaceComposer.samples,
        spaceToolHeader: spaceToolHeader.samples,
      },
    }, null, 1));
    console.log(`[jitter-probe] ${JSON.stringify(keysSummary)}`);
    return { reversals: 0, ...keysSummary } as unknown as { reversals: number };
  }

  if (entryMode) {
  // ── Phase A: COLD FIRST ENTRY into a session that already has history ────
  // Runs before every other phase on purpose: this is the user's "최초 진입"
  // — no cached row heights, and the markdown/diff chunks are as cold as they
  // are right after launch. The transcript must land bottom-pinned and hold
  // still while the estimated rows are re-measured.
  const coldStamp = Date.now() % 100_000;
  const coldItems = coldHistoryItems(84, coldStamp);
  // Pick the transcript of the VISIBLE route: background tabs keep their own
  // (taller, scrolled-away) transcript mounted. Prewarm rows live in a hidden
  // sibling container, so only DIRECT children of the virtual space count.
  const pickTranscript = `(() => {
    const nodes = [...document.querySelectorAll('.transcript')]
      .filter((node) => node.getBoundingClientRect().height > 0);
    if (nodes.length === 0) return null;
    return nodes
      .map((node) => ({
        node,
        rows: node.querySelectorAll('.transcript-virtual-space > .transcript-virtual-row').length,
      }))
      .sort((a, b) => b.rows - a.rows || b.node.scrollHeight - a.node.scrollHeight)[0].node;
  })()`;
  const install = `(() => {
    const w = window;
    if (w.__entry && w.__entry.raf) cancelAnimationFrame(w.__entry.raf);
    w.__entry = { samples: [], raf: 0 };
    const sample = () => {
      const el = ${pickTranscript};
      if (el) {
        const box = el.getBoundingClientRect();
        const rows = [...el.querySelectorAll('.transcript-virtual-space > .transcript-virtual-row')]
          .map((row) => ({ row, rect: row.getBoundingClientRect() }))
          // Off-screen overscan rows may legitimately shift while the view is
          // pinned; only VISIBLE movement is the reported bounce.
          .filter(({ rect }) => rect.bottom > box.top && rect.top < box.bottom)
          .map(({ row, rect }) => ({
            i: Number(row.getAttribute('data-index')),
            top: Math.round(rect.top - box.top),
          }));
        w.__entry.samples.push({
          t: Math.round(performance.now()),
          st: Math.round(el.scrollTop),
          sh: Math.round(el.scrollHeight),
          ch: Math.round(el.clientHeight),
          space: Math.round(el.querySelector('.transcript-virtual-space')
            ?.getBoundingClientRect().height || 0),
          // Layout bands around the transcript: a band that appears AFTER
          // entry shrinks the viewport and drags the pinned content with it.
          bands: [
            '.turn-review-bar', '.composer-region', '.composer-context-bar',
            '.runtime-progress', '.inline-error', '.live-work', '.transcript-shell',
          ].map((selector) => {
            const node = document.querySelector(selector);
            return node ? Math.round(node.getBoundingClientRect().height) : 0;
          }),
          dist: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
          following: el.getAttribute('data-following') === 'true',
          plain: el.querySelectorAll('.markdown-plain').length,
          queueHeight: Math.round((el.closest('.conversation') || document)
            .querySelector('.queue-list')?.getBoundingClientRect().height || 0),
          review: (() => {
            const shell = el.closest('.conversation') || document;
            const review = shell.querySelector('.turn-review-bar');
            if (!review) return null;
            const reviewBox = review.getBoundingClientRect();
            const activity = el.querySelector('.live-activity-status');
            const activityBox = activity?.getBoundingClientRect();
            const composer = shell.querySelector('.composer');
            const composerBox = composer?.getBoundingClientRect();
            return {
              height: Math.round(reviewBox.height),
              overlap: Math.max(0, Math.round(box.bottom - reviewBox.top)),
              thinkingGap: activityBox ? Math.round(reviewBox.top - activityBox.bottom) : null,
              composerGap: composerBox ? Math.round(composerBox.top - reviewBox.bottom) : null,
            };
          })(),
          subject: (() => {
            const card = w.__entryCard;
            const row = card?.closest('.transcript-virtual-row');
            if (!card || !row || !row.isConnected) return null;
            return {
              open: card.getAttribute('data-open') === 'true',
              rowHeight: Math.round(row.getBoundingClientRect().height),
              cardHeight: Math.round(card.getBoundingClientRect().height),
            };
          })(),
          composer: (() => {
            const region = document.querySelector('.composer-region');
            if (!region) return null;
            const walk = (node, depth) => [...node.children].flatMap((child) => {
              const height = Math.round(child.getBoundingClientRect().height);
              const entry = [String(child.className || child.tagName), height];
              return depth > 0 ? [entry, ...walk(child, depth - 1)] : [entry];
            });
            return walk(region, 2);
          })(),
          rows,
        });
      }
      w.__entry.raf = requestAnimationFrame(sample);
    };
    w.__entry.raf = requestAnimationFrame(sample);
    return true;
  })()`;
  const stop = `(() => {
    const w = window;
    cancelAnimationFrame(w.__entry.raf);
    w.__entry.raf = 0;
    return w.__entry.samples;
  })()`;

  // Enter through the real resume path: a snapshot pushed for a foreign
  // session id never reaches the visible route.
  const coldSnapshot = {
    ...baseSnapshot,
    toasts: [],
    sessionId: 'probe_session_cold',
    busy: true,
    spinner: {
      active: true,
      mode: 'responding',
      startedAt: Date.now(),
    },
    items: coldItems,
    streamingTail: null,
  };
  const delayedReviewItems = coldItems.map((item) => item.id === `cold-${coldStamp}-tool-tail`
    ? {
        ...item,
        result: `${String(item.result || '')}
diff --git a/src/probe.ts b/src/probe.ts
--- a/src/probe.ts
+++ b/src/probe.ts
@@ -1 +1 @@
-const stable = false;
+const stable = true;`,
      }
    : item);
  const delayedReviewSnapshot = {
    ...coldSnapshot,
    items: delayedReviewItems,
  };
  const queuedSnapshot = {
    ...delayedReviewSnapshot,
    queued: [{
      id: `cold-${coldStamp}-queued-followup`,
      text: 'queued follow-up geometry probe',
    }],
  };
  prepareColdResume(coldSnapshot);
  await window.webContents.executeJavaScript(install);
  const coldClick = await window.webContents.executeJavaScript(`(async () => {
    const row = document.querySelector('[data-session-id="probe_session_cold"]');
    if (!(row instanceof HTMLElement)) throw new Error('Missing cold probe session row');
    row.click();
    await new Promise((resolve) => setTimeout(resolve, 600));
    return {
      tabs: [...document.querySelectorAll('.workspace-tab')].map((tab) => tab.textContent.slice(0, 24)),
      errors: [...document.querySelectorAll('.inline-error, .runtime-progress')]
        .map((node) => node.textContent.slice(0, 120)),
    };
  })()`) as Record<string, unknown>;
  // The route is now bound to the cold session id, so the history batch
  // lands through the normal state push (one commit, like a real resume).
  send(coldSnapshot);
  // Cover the 6s worker-review poll as well as any delayed renderer idle work.
  await sleep(5_800);
  // A worker-only diff becomes known late without adding a transcript row.
  // The bottom stack must grow once, retain the followed bottom, preserve the
  // thinking gap, and never cover transcript content.
  send(delayedReviewSnapshot);
  await sleep(1_200);
  const entrySamples = await window.webContents.executeJavaScript(stop) as RowSample[];
  const firstReviewFrame = entrySamples.findIndex((sample) => Number(sample.review?.height || 0) > 0);
  const entry = contentMotion(firstReviewFrame > 0
    ? entrySamples.slice(0, firstReviewFrame)
    : entrySamples);
  const delayedReviewSamples = firstReviewFrame >= 0
    ? entrySamples.slice(Math.max(0, firstReviewFrame - 2))
    : [];
  const visibleReviewSamples = delayedReviewSamples.filter((sample) => sample.review);
  const settledReviewSamples = visibleReviewSamples.slice(-5);
  const thinkingGaps = visibleReviewSamples
    .map((sample) => sample.review?.thinkingGap)
    .filter((value): value is number => Number.isFinite(value));
  const composerGaps = visibleReviewSamples
    .map((sample) => sample.review?.composerGap)
    .filter((value): value is number => Number.isFinite(value));
  const settledThinkingGaps = settledReviewSamples
    .map((sample) => sample.review?.thinkingGap)
    .filter((value): value is number => Number.isFinite(value));
  const settledComposerGaps = settledReviewSamples
    .map((sample) => sample.review?.composerGap)
    .filter((value): value is number => Number.isFinite(value));
  const delayedReview = {
    appeared: firstReviewFrame > 0
      && entrySamples.slice(0, firstReviewFrame).some((sample) => !sample.review),
    height: firstReviewFrame >= 0 ? Number(entrySamples[firstReviewFrame].review?.height || 0) : 0,
    maxOverlap: delayedReviewSamples.length
      ? Math.max(...delayedReviewSamples.map((sample) => Number(sample.review?.overlap || 0)))
      : Number.MAX_SAFE_INTEGER,
    minThinkingGap: thinkingGaps.length ? Math.min(...thinkingGaps) : null,
    minComposerGap: composerGaps.length ? Math.min(...composerGaps) : null,
    settledThinkingGap: settledThinkingGaps.length ? Math.min(...settledThinkingGaps) : null,
    settledComposerGap: settledComposerGaps.length ? Math.min(...settledComposerGaps) : null,
    settledMaxDistance: settledReviewSamples.length
      ? Math.max(...settledReviewSamples.map((sample) => sample.dist))
      : Number.MAX_SAFE_INTEGER,
    // The rAF sampler forces the new layout before ResizeObserver callbacks.
    // One raw sample may therefore precede the same-frame pre-paint pin.
    correctionFrames: visibleReviewSamples.findIndex((sample) =>
      sample.dist <= 8 && Number(sample.review?.thinkingGap) >= 18),
    motion: contentMotion(delayedReviewSamples),
  };
  const entryDiag = await window.webContents.executeJavaScript(`(() => {
    const el = ${pickTranscript};
    const shell = el?.closest('.conversation') || document;
    return {
      transcripts: document.querySelectorAll('.transcript').length,
      coldVisible: (document.body.textContent || '').includes('cold entry question'),
      rows: el ? el.querySelectorAll('.transcript-virtual-space > .transcript-virtual-row').length : 0,
      toolCards: el ? el.querySelectorAll('.tool-card').length : 0,
      reviewBarHeight: Math.round(shell.querySelector('.turn-review-bar')?.getBoundingClientRect().height || 0),
      markdownPlainFallbacks: Math.max(0, ...window.__entry.samples.map((sample) => Number(sample.plain || 0))),
      settledMarkdownPlainFallbacks: Math.max(
        0,
        ...window.__entry.samples.slice(-20).map((sample) => Number(sample.plain || 0)),
      ),
      scrollHeight: el ? Math.round(el.scrollHeight) : 0,
      clientHeight: el ? Math.round(el.clientHeight) : 0,
      dist: el ? Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) : null,
    };
  })()`) as Record<string, unknown>;
  Object.assign(entryDiag, { click: coldClick });

  const toggleReview = async (label: string, targetExpanded: boolean) => {
    await window.webContents.executeJavaScript(install);
    // Preserve several collapsed/expanded baseline frames before the click.
    await sleep(100);
    const clicked = await window.webContents.executeJavaScript(`(() => {
      const el = ${pickTranscript};
      const summary = el?.closest('.conversation')?.querySelector('.turn-review-summary');
      if (!(summary instanceof HTMLElement)) return false;
      const expanded = summary.getAttribute('aria-expanded') === 'true';
      if (expanded !== ${targetExpanded ? 'true' : 'false'}) summary.click();
      return true;
    })()`) as boolean;
    await sleep(700);
    const samples = await window.webContents.executeJavaScript(stop) as RowSample[];
    const expanded = await window.webContents.executeJavaScript(`(() => {
      const el = ${pickTranscript};
      return el?.closest('.conversation')?.querySelector('.turn-review-summary')
        ?.getAttribute('aria-expanded') === 'true';
    })()`) as boolean;
    const reviewSamples = samples.filter((sample) => sample.review);
    const settledSamples = reviewSamples.slice(-5);
    const thinkingGap = reviewSamples
      .map((sample) => sample.review?.thinkingGap)
      .filter((value): value is number => Number.isFinite(value));
    const composerGap = reviewSamples
      .map((sample) => sample.review?.composerGap)
      .filter((value): value is number => Number.isFinite(value));
    const settledThinkingGap = settledSamples
      .map((sample) => sample.review?.thinkingGap)
      .filter((value): value is number => Number.isFinite(value));
    const settledComposerGap = settledSamples
      .map((sample) => sample.review?.composerGap)
      .filter((value): value is number => Number.isFinite(value));
    return {
      label,
      clicked,
      expanded,
      maxOverlap: reviewSamples.length
        ? Math.max(...reviewSamples.map((sample) => Number(sample.review?.overlap || 0)))
        : Number.MAX_SAFE_INTEGER,
      minThinkingGap: thinkingGap.length ? Math.min(...thinkingGap) : null,
      minComposerGap: composerGap.length ? Math.min(...composerGap) : null,
      settledThinkingGap: settledThinkingGap.length ? Math.min(...settledThinkingGap) : null,
      settledComposerGap: settledComposerGap.length ? Math.min(...settledComposerGap) : null,
      settledMaxDistance: settledSamples.length
        ? Math.max(...settledSamples.map((sample) => sample.dist))
        : Number.MAX_SAFE_INTEGER,
      followingAfter: samples.at(-1)?.following ?? null,
      finalDistance: samples.at(-1)?.dist ?? null,
      motion: contentMotion(samples),
      samples,
    };
  };
  const reviewExpand = await toggleReview('review-expand', true);
  const reviewCollapse = await toggleReview('review-collapse', false);
  const toggleQueue = async (
    label: string,
    nextSnapshot: Record<string, unknown>,
    targetVisible: boolean,
  ) => {
    await window.webContents.executeJavaScript(install);
    await sleep(100);
    send(nextSnapshot);
    await sleep(700);
    const samples = await window.webContents.executeJavaScript(stop) as RowSample[];
    const baseline = samples.slice(0, Math.min(5, samples.length));
    const settled = samples.slice(-5);
    const visibleBefore = baseline.some((sample) => Number(sample.queueHeight || 0) > 0);
    const visibleAfter = settled.some((sample) => Number(sample.queueHeight || 0) > 0);
    return {
      label,
      targetVisible,
      transitioned: targetVisible
        ? !visibleBefore && visibleAfter
        : visibleBefore && !visibleAfter,
      finalHeight: Number(samples.at(-1)?.queueHeight || 0),
      followingAfter: samples.at(-1)?.following ?? null,
      finalDistance: samples.at(-1)?.dist ?? null,
      motion: contentMotion(samples),
      samples,
    };
  };
  const queueMount = await toggleQueue('queue-mount', queuedSnapshot, true);
  const queueUnmount = await toggleQueue('queue-unmount', delayedReviewSnapshot, false);
  prepareColdResume(delayedReviewSnapshot);

  // Re-entry: leave the session and come back. Everything the first visit
  // resolved asynchronously (worker review bar, row heights) must now be
  // known up front, so the second entry may not move at all.
  await window.webContents.executeJavaScript(`(async () => {
    const link = document.querySelector('button[aria-label="New task"]');
    if (link instanceof HTMLElement) link.click();
    await new Promise((resolve) => setTimeout(resolve, 700));
    return true;
  })()`);
  await window.webContents.executeJavaScript(install);
  await window.webContents.executeJavaScript(`(async () => {
    const row = document.querySelector('[data-session-id="probe_session_cold"]');
    if (!(row instanceof HTMLElement)) throw new Error('Missing cold probe session row');
    row.click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    return true;
  })()`);
  send(delayedReviewSnapshot);
  await sleep(2_000);
  const reentrySamples = await window.webContents.executeJavaScript(stop) as RowSample[];
  const reentry = contentMotion(reentrySamples);

  // ── Phase B: tool-card expand / collapse ────────────────────────────────
  // The toggled card's own top must not move, and neither may the rest of
  // the visible transcript (user: 도구 사용 표기 펼침/접힘도 같은 출렁임).
  const toggle = async (label: string, pinned: boolean, targetExpanded: boolean) => {
    // Select (and if needed scroll to) the subject card BEFORE sampling, so
    // the recorded frames contain only the toggle's own motion.
    const prepared = await window.webContents.executeJavaScript(`(async () => {
      const el = ${pickTranscript};
      if (!el) return false;
      let box = el.getBoundingClientRect();
      const headers = [...el.querySelectorAll('.tool-card .tool-header')]
        .filter((node) => !node.disabled);
      const visible = headers.filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.top >= box.top && rect.bottom <= box.bottom;
      });
      const pinnedPass = ${pinned ? 'true' : 'false'};
      let header = pinnedPass ? visible[visible.length - 1] : visible[0];
      if (!header && !pinnedPass && headers.length > 0) {
        // Reading position: bring a mid-transcript card into view first.
        header = headers[Math.floor(headers.length / 2)];
        header.scrollIntoView({ block: 'center' });
        await new Promise((resolve) => setTimeout(resolve, 400));
        box = el.getBoundingClientRect();
      }
      window.__entryHeader = header || null;
      return Boolean(header);
    })()`) as boolean;
    await sleep(300);
    await window.webContents.executeJavaScript(install);
    const clicked = await window.webContents.executeJavaScript(`(() => {
      const el = ${pickTranscript};
      const header = window.__entryHeader;
      if (!el || !header || !header.isConnected) return null;
      const box = el.getBoundingClientRect();
      const card = header.closest('.tool-card');
      const row = card.closest('.transcript-virtual-row');
      const space = el.querySelector('.transcript-virtual-space');
      const before = {
        top: Math.round(card.getBoundingClientRect().top - box.top),
        scrollTop: Math.round(el.scrollTop),
        scrollHeight: Math.round(el.scrollHeight),
        spaceHeight: Math.round(space?.getBoundingClientRect().height || 0),
        rowHeight: Math.round(row?.getBoundingClientRect().height || 0),
        cardHeight: Math.round(card.getBoundingClientRect().height),
      };
      window.__entryCard = card;
      const open = card.getAttribute('data-open') === 'true';
      if (open !== ${targetExpanded ? 'true' : 'false'}) {
        header.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, button: 0, buttons: 1, pointerId: 1,
        }));
        header.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, button: 0, buttons: 0, pointerId: 1,
        }));
        header.click();
      }
      return { before, open };
    })()`) as {
      before: {
        top: number;
        scrollTop: number;
        scrollHeight: number;
        spaceHeight: number;
        rowHeight: number;
        cardHeight: number;
      };
      open: boolean;
    } | null;
    await sleep(1_000);
    const samples = await window.webContents.executeJavaScript(stop) as RowSample[];
    const card = await window.webContents.executeJavaScript(`(() => {
      const el = ${pickTranscript};
      const card = window.__entryCard;
      if (!el || !card || !card.isConnected) return null;
      const row = card.closest('.transcript-virtual-row');
      const space = el.querySelector('.transcript-virtual-space');
      return {
        top: Math.round(card.getBoundingClientRect().top - el.getBoundingClientRect().top),
        open: card.getAttribute('data-open'),
        subjectKey: row?.getAttribute('data-timeline-key') || '',
        scrollTop: Math.round(el.scrollTop),
        scrollHeight: Math.round(el.scrollHeight),
        spaceHeight: Math.round(space?.getBoundingClientRect().height || 0),
        rowHeight: Math.round(row?.getBoundingClientRect().height || 0),
        cardHeight: Math.round(card.getBoundingClientRect().height),
      };
    })()`) as {
      top: number;
      open: string;
      subjectKey: string;
      scrollTop: number;
      scrollHeight: number;
      spaceHeight: number;
      rowHeight: number;
      cardHeight: number;
    } | null;
    const scrollDelta = clicked && card ? card.scrollTop - clicked.before.scrollTop : null;
    const scrollHeightDelta = clicked && card
      ? card.scrollHeight - clicked.before.scrollHeight
      : null;
    const spaceHeightDelta = clicked && card
      ? card.spaceHeight - clicked.before.spaceHeight
      : null;
    const rowHeightDelta = clicked && card
      ? card.rowHeight - clicked.before.rowHeight
      : null;
    const cardHeightDelta = clicked && card
      ? card.cardHeight - clicked.before.cardHeight
      : null;
    return {
      label,
      prepared,
      clicked: Boolean(clicked),
      targetExpanded,
      subjectKey: card?.subjectKey ?? null,
      cardShift: clicked && card ? card.top - clicked.before.top : null,
      openAfter: card?.open ?? null,
      scrollDelta,
      scrollHeightDelta,
      spaceHeightDelta,
      rowHeightDelta,
      cardHeightDelta,
      scrollError: scrollDelta === null || scrollHeightDelta === null
        ? null
        : scrollDelta - (pinned ? scrollHeightDelta : 0),
      rowGeometryError: rowHeightDelta === null || cardHeightDelta === null
        ? null
        : rowHeightDelta - cardHeightDelta,
      spaceGeometryError: spaceHeightDelta === null || cardHeightDelta === null
        ? null
        : spaceHeightDelta - cardHeightDelta,
      followingAfter: samples.at(-1)?.following ?? null,
      finalDistance: samples.at(-1)?.dist ?? null,
      motion: contentMotion(samples),
      samples,
    };
  };
  // Pinned pass first (the common case: the newest tool card at the bottom of
  // a followed transcript), then the scrolled-up reading case.
  const pinnedExpand = await toggle('pinned-expand', true, true);
  await window.webContents.executeJavaScript(`(async () => {
    const link = document.querySelector('button[aria-label="New task"]');
    if (link instanceof HTMLElement) link.click();
    await new Promise((resolve) => setTimeout(resolve, 700));
    return true;
  })()`);
  await window.webContents.executeJavaScript(install);
  await window.webContents.executeJavaScript(`(async () => {
    const row = document.querySelector('[data-session-id="probe_session_cold"]');
    if (!(row instanceof HTMLElement)) throw new Error('Missing cold probe session row');
    row.click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    return true;
  })()`);
  send(delayedReviewSnapshot);
  await sleep(1_200);
  const expandedReentrySamples = await window.webContents.executeJavaScript(stop) as RowSample[];
  const expandedReentry = contentMotion(expandedReentrySamples);
  const expandedReentryOpenTools = await window.webContents.executeJavaScript(
    `document.querySelectorAll('.tool-card[data-open="true"]').length`,
  ) as number;
  const pinnedCollapse = await toggle('pinned-collapse', true, false);
  const pinnedExpandAgain = await toggle('pinned-expand-again', true, true);
  await window.webContents.executeJavaScript(install);
  send({
    ...delayedReviewSnapshot,
    items: [
      ...delayedReviewItems,
      {
        id: `cold-${coldStamp}-append-after-toggle`,
        kind: 'assistant',
        text: 'follow remains pinned after a tool disclosure changes height',
      },
    ],
  });
  await sleep(700);
  const pinnedAppendSamples = await window.webContents.executeJavaScript(stop) as RowSample[];
  const pinnedAppend = {
    followingAfter: pinnedAppendSamples.at(-1)?.following ?? null,
    finalDistance: pinnedAppendSamples.at(-1)?.dist ?? null,
    motion: contentMotion(pinnedAppendSamples),
  };
  await window.webContents.executeJavaScript(`(async () => {
    const el = ${pickTranscript};
    if (!el) return false;
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 1_200);
    await new Promise((resolve) => setTimeout(resolve, 500));
    return true;
  })()`);
  const expand = await toggle('expand', false, true);
  const collapse = await toggle('collapse', false, false);
  const toggleSamples = {
    reviewExpand: reviewExpand.samples,
    reviewCollapse: reviewCollapse.samples,
    pinnedExpand: pinnedExpand.samples,
    pinnedCollapse: pinnedCollapse.samples,
    pinnedAppend: pinnedAppendSamples,
    expand: expand.samples,
    collapse: collapse.samples,
  };

    const { samples: _pe, ...pinnedExpandOnly } = pinnedExpand;
    const { samples: _pc, ...pinnedCollapseOnly } = pinnedCollapse;
    const { samples: _e, ...expandOnly } = expand;
    const { samples: _c, ...collapseOnly } = collapse;
    const { samples: _re, ...reviewExpandOnly } = reviewExpand;
    const { samples: _rc, ...reviewCollapseOnly } = reviewCollapse;
    const { samples: _qm, ...queueMountOnly } = queueMount;
    const { samples: _qu, ...queueUnmountOnly } = queueUnmount;
    const entrySummary = {
      coldEntry: entry,
      coldReentry: reentry,
      delayedReview,
      reviewExpand: reviewExpandOnly,
      reviewCollapse: reviewCollapseOnly,
      queueMount: queueMountOnly,
      queueUnmount: queueUnmountOnly,
      coldEntryDiag: entryDiag,
      expandedToolReentry: {
        motion: expandedReentry,
        openTools: expandedReentryOpenTools,
      },
      toolTogglePinnedExpand: pinnedExpandOnly,
      toolTogglePinnedExpandAgain: (() => {
        const { samples: _samples, ...rest } = pinnedExpandAgain;
        return rest;
      })(),
      toolTogglePinnedCollapse: pinnedCollapseOnly,
      toolTogglePinnedAppend: pinnedAppend,
      toolToggleExpand: expandOnly,
      toolToggleCollapse: collapseOnly,
    };
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({
      summary: entrySummary,
      entrySamples,
      reentrySamples,
      expandedReentrySamples,
      queueMountSamples: queueMount.samples,
      queueUnmountSamples: queueUnmount.samples,
      toggleSamples,
    }, null, 1));
    console.log(`[jitter-probe] ${JSON.stringify(entrySummary)}`);
    return {
      reversals: Math.max(
        entry.reversals,
        reentry.reversals,
        delayedReview.motion.reversals,
        expandedReentry.reversals,
        reviewExpand.motion.reversals,
        reviewCollapse.motion.reversals,
        queueMount.motion.reversals,
        queueUnmount.motion.reversals,
        pinnedExpand.motion.reversals,
        pinnedExpandAgain.motion.reversals,
        pinnedCollapse.motion.reversals,
        expand.motion.reversals,
        collapse.motion.reversals,
      ),
      ...entrySummary,
    } as unknown as { reversals: number };
  }

  // Phase 0: idle short session A on screen.
  const sessionA = {
    ...baseSnapshot,
    toasts: [],
    sessionId: 'probe_session_a',
    busy: false,
    items: probeItems(6),
    streamingTail: null,
  };
  send(sessionA);
  await sleep(700);

  // Shared conversation for session B. The persisted restore ends at the
  // user's last message (marker below); the owner FULL frame carries the
  // progressed turn under the OWNER's id namespace for the recent rows.
  const items = probeItems(88);
  items[60] = {
    ...items[60],
    text: `${String(items[60]?.text || '')} probe persisted last user`,
  };
  // Rows from here on were created by the owner AFTER the viewer's last
  // visit persisted its restore ids — the live frame re-identifies them.
  const OWNER_REMAP_FROM = 45;
  const ownerItems = () => items.map((item, index) => (
    index >= OWNER_REMAP_FROM ? { ...item, id: `own-${String(item.id)}` } : item
  ));

  // Phase 0.5: previous visit. The viewer has ALREADY displayed session B
  // under its first-seen (restore) ids and navigated away. The later live
  // entry re-identifies the tail region (owner ids); the renderer must adopt
  // those ids in place instead of remounting the rows — the remount path was
  // the up/down shake reported when entering the working session.
  send({
    ...baseSnapshot,
    toasts: [],
    sessionId: 'probe_session_b',
    busy: false,
    items: items.slice(0, 61),
    streamingTail: null,
    sessionRemoteAttached: true,
  });
  await sleep(500);
  send(sessionA);
  await sleep(400);

  // Install the per-frame sampler BEFORE entering the streaming session.
  await window.webContents.executeJavaScript(`(() => {
    const w = window;
    w.__jitter = { samples: [], raf: 0 };
    const sample = () => {
      const el = document.querySelector('.transcript');
      if (el) {
        const box = el.getBoundingClientRect();
        const virtualRows = el.querySelectorAll('.transcript-virtual-row');
        const tail = el.querySelector('.transcript-live-part')?.closest('.transcript-virtual-row')
          || virtualRows[virtualRows.length - 1]
          || null;
        const tailBody = tail?.querySelector('.message-body');
        const thread = el.querySelector('.thread');
        w.__jitter.samples.push({
          t: Math.round(performance.now()),
          st: Math.round(el.scrollTop),
          dist: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
          tailTop: tail ? Math.round(tail.getBoundingClientRect().bottom - box.bottom) : null,
          tailIndex: tail ? Number(tail.getAttribute('data-index')) : null,
          tailBodyBottom: tailBody ? Math.round(tailBody.getBoundingClientRect().bottom - box.bottom) : null,
          th: thread ? Math.round(thread.getBoundingClientRect().height) : 0,
          partialVisible: (document.body.textContent || '').includes('probe persisted last user')
            && !tail,
        });
      }
      w.__jitter.raf = requestAnimationFrame(sample);
    };
    w.__jitter.raf = requestAnimationFrame(sample);
    return true;
  })()`);

  // Phase 1: remoteAttached ENTER session B. The stored restore ends at the
  // user's last message; the owner FULL frame already contains the progressed
  // turn and streaming tail. CaptureService holds the former and resolves
  // resume with the latter, matching the real live-share entry barrier.
  let tailText = assistantMarkdown(97);
  const tail = () => ({ id: 'probe-tail', kind: 'assistant', text: tailText, streaming: true });
  const sessionB = () => ({
    ...baseSnapshot,
    toasts: [],
    sessionId: 'probe_session_b',
    busy: true,
    spinner: { label: 'Wrapping' },
    items: ownerItems(),
    streamingTail: tail(),
  });
  const storedSessionB = {
    ...sessionB(),
    busy: false,
    spinner: null,
    items: items.slice(0, 61),
    streamingTail: null,
    sessionRemoteAttached: true,
  };
  prepareRemoteResume(storedSessionB, {
    ...sessionB(),
    sessionRemoteAttached: true,
  });
  await window.webContents.executeJavaScript(`(async () => {
    const row = document.querySelector('[data-session-id="probe_session_b"]');
    if (!(row instanceof HTMLElement)) throw new Error('Missing remote probe session row');
    row.click();
    await new Promise((resolve) => setTimeout(resolve, 420));
    return true;
  })()`);

  // Phase 2: stream for ~3.2s — tail grows every frame-ish tick; a settled
  // assistant row is appended every ~500ms (count change → followOnAppend
  // path); occasionally the tail REWRITES shorter (markdown reflow).
  const startedAt = Date.now();
  let ticks = 0;
  while (Date.now() - startedAt < 3200) {
    await sleep(66);
    ticks += 1;
    if (ticks % 8 === 0) {
      items.push({ id: `probe-appended-${ticks}`, kind: 'assistant', text: assistantMarkdown(200 + ticks) });
    }
    if (ticks % 13 === 0) {
      // Simulate a fenced-block reflow: streamed markdown collapses shorter.
      tailText = tailText.slice(0, Math.max(80, tailText.length - 220));
    }
    tailText += ` ${paragraph(300 + ticks, 1)}`;
    if (ticks % 5 === 0) tailText += '\n\n';
    send(sessionB());
  }

  // Phase 3: settle the streaming assistant and fold the successful
  // completion footer into that same projected assistant row. `data-index`
  // belongs to the projected timeline (including TurnGap rows), not `items`.
  // Capture the actual live row index before completion so the same visible
  // assistant must remain the tail anchor throughout settlement.
  const finishStart = await window.webContents.executeJavaScript(
    'window.__jitter.samples.length',
  ) as number;
  const completedVisibleTailIndex = await window.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('.transcript-live-part')?.closest('.transcript-virtual-row');
    const index = row?.getAttribute('data-index');
    return index == null ? null : Number(index);
  })()`) as number | null;
  if (!Number.isInteger(completedVisibleTailIndex)) {
    throw new Error('Missing projected live tail before completion settlement');
  }
  send({
    ...sessionB(),
    // Keep the capture-only route alive while measuring. Removing spinner and
    // streamingTail produces the same visible completion geometry; busy only
    // prevents the synthetic host from cleaning up its task tab mid-sample.
    busy: true,
    spinner: null,
    items: [
      ...ownerItems(),
      { ...tail(), streaming: false },
      {
        id: 'probe-turn-done',
        kind: 'turndone',
        status: 'done',
        verb: 'Completed',
        elapsedMs: Date.now() - startedAt,
      },
    ],
    streamingTail: null,
  });
  await sleep(700);

  // Freeze the jitter samples BEFORE the scroll-to-top passes: phase 4
  // scrolls away from the bottom on purpose, which must not pollute the
  // entry/stream/settlement metrics (it used to count as partial/off-bottom
  // frames and fail the probe assertions spuriously).
  await window.webContents.executeJavaScript(
    '(() => { const w = window; cancelAnimationFrame(w.__jitter.raf); return w.__jitter.samples.length; })()',
  );

  // Phase 4: first-scroll-to-top jank (user report: entering a session and
  // scrolling to the TOP always lags the first time). Two identical upward
  // passes: pass 1 is COLD (every row above the viewport mounts + measures +
  // compensates), pass 2 is WARM (virtualizer measurement cache hit). The
  // delta between the two isolates the first-pass cost.
  // The synthetic host can tear the probe route down between phases — re-push
  // the completed snapshot immediately before measuring so the virtualized
  // transcript is guaranteed on screen.
  send({
    ...sessionB(),
    busy: true,
    spinner: null,
    items: [
      ...ownerItems(),
      { ...tail(), streaming: false },
    ],
    streamingTail: null,
  });
  await sleep(600);
  const scrollPasses = await window.webContents.executeJavaScript(`(async () => {
    // The workspace may have navigated off the probe session between phases —
    // re-enter it, then measure the transcript that actually has content.
    const row = document.querySelector('[data-session-id="probe_session_b"]');
    if (row instanceof HTMLElement) {
      row.click();
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    const el = [...document.querySelectorAll('.transcript')]
      .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    if (!el) return null;
    const disarmFollow = () => el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
    const stats = (frames) => {
      const sorted = [...frames].sort((a, b) => a - b);
      const total = frames.reduce((a, b) => a + b, 0);
      return {
        frames: frames.length,
        totalMs: Math.round(total),
        maxMs: Math.round(frames.length ? Math.max(...frames) : 0),
        p95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] || 0),
        longFrames: frames.filter((value) => value > 33).length,
      };
    };
    const passUp = () => new Promise((resolve) => {
      const frames = [];
      let last = performance.now();
      const step = () => {
        const now = performance.now();
        frames.push(now - last);
        last = now;
        el.scrollTop = Math.max(0, el.scrollTop - 700);
        if (el.scrollTop <= 0) { requestAnimationFrame(() => resolve(frames)); return; }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(() => { last = performance.now(); requestAnimationFrame(step); });
    });
    disarmFollow();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const diag = {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollTop: Math.round(el.scrollTop),
      virtualRows: el.querySelectorAll('.transcript-virtual-row').length,
      virtualSpace: el.querySelector('.transcript-virtual-space')?.getBoundingClientRect().height ?? null,
    };
    const pass1 = stats(await passUp());
    // Return to the bottom for the warm pass; re-assert after layout settles
    // so pass 2 genuinely starts from the far end.
    el.scrollTop = el.scrollHeight;
    await new Promise((resolve) => setTimeout(resolve, 400));
    el.scrollTop = el.scrollHeight;
    await new Promise((resolve) => setTimeout(resolve, 200));
    disarmFollow();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const pass2 = stats(await passUp());
    return { pass1, pass2, diag };
  })()`) as {
    pass1: Record<string, number>;
    pass2: Record<string, number>;
    diag: Record<string, number | null>;
  } | null;

  const report = await window.webContents.executeJavaScript(
    'window.__jitter.samples',
  ) as Array<{
    t: number;
    st: number;
    dist: number;
    tailTop: number | null;
    tailIndex: number | null;
    tailBodyBottom: number | null;
    th: number;
    partialVisible: boolean;
  }>;

  // The sampler starts BEFORE the session-row click, so report.slice(5) only
  // discarded five blank pre-navigation frames and still counted the entry
  // settle as a streaming reversal. Start from the first real tail, then skip
  // its ENTRY-SETTLE window: bands below the transcript (the worker review
  // bar) mount one IPC round-trip after the first paint and shrink the pinned
  // viewport. That entry-layout behaviour is what the `entry` pass measures;
  // this pass is about follow stability WHILE STREAMING.
  const ENTRY_SETTLE_MS = 400;
  const firstTailFrame = report.findIndex((sample, index) =>
    index < finishStart && sample.tailIndex != null);
  let activeStart = Math.min(finishStart, 5);
  if (firstTailFrame >= 0) {
    const settleUntil = report[firstTailFrame].t + ENTRY_SETTLE_MS;
    let index = firstTailFrame + 5;
    while (index < finishStart && report[index].t < settleUntil) index += 1;
    activeStart = Math.min(finishStart, index);
  }
  const active = report.slice(activeStart, finishStart);
  let reversals = 0;
  let maxSwing = 0;
  let lastDelta = 0;
  for (let i = 1; i < active.length; i++) {
    const prev = active[i - 1];
    const next = active[i];
    if (prev.tailTop == null || next.tailTop == null) {
      lastDelta = 0;
      continue;
    }
    const delta = next.tailTop - prev.tailTop;
    if (Math.abs(delta) > 3 && Math.abs(lastDelta) > 3 && Math.sign(delta) !== Math.sign(lastDelta)) {
      reversals += 1;
      maxSwing = Math.max(maxSwing, Math.abs(delta) + Math.abs(lastDelta));
    }
    if (Math.abs(delta) > 3) lastDelta = delta;
  }
  const distances = active.map((sample) => sample.dist);
  const finish = report.slice(finishStart);
  const finishTailTops = finish
    .map((sample) => sample.tailTop)
    .filter((value): value is number => value != null);
  const finishBodyBottoms = finish
    .map((sample) => sample.tailBodyBottom)
    .filter((value): value is number => value != null);
  const finishMaxTailShift = finishTailTops.length > 0
    ? Math.max(...finishTailTops) - Math.min(...finishTailTops)
    : Number.MAX_SAFE_INTEGER;
  const finishMaxBodyShift = finishBodyBottoms.length > 0
    ? Math.max(...finishBodyBottoms) - Math.min(...finishBodyBottoms)
    : Number.MAX_SAFE_INTEGER;
  const summary = {
    frames: active.length,
    reversals,
    maxSwing,
    maxDistance: Math.max(...distances),
    meanDistance: Math.round(distances.reduce((a, b) => a + b, 0) / Math.max(1, distances.length)),
    offBottomFrames: distances.filter((d) => d > 8).length,
    partialFrames: report.filter((sample) => sample.partialVisible).length,
    finishFrames: finish.length,
    finishMaxTailShift,
    finishMaxBodyShift,
    finishOffBottomFrames: finish.filter((sample) => sample.dist > 8).length,
    finishMissingTailFrames: finish.filter((sample) => sample.tailIndex == null).length,
    finishWrongTailFrames: finish.filter(
      (sample) => sample.tailIndex != null && sample.tailIndex !== completedVisibleTailIndex,
    ).length,
    scrollToTopPass1: scrollPasses?.pass1 ?? null,
    scrollToTopPass2: scrollPasses?.pass2 ?? null,
    scrollToTopDiag: scrollPasses?.diag ?? null,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({
    summary,
    samples: report,
  }, null, 1));
  console.log(`[jitter-probe] ${JSON.stringify(summary)}`);
  return summary;
}

export function jitterProbeOutPath(appRoot: string): string {
  return join(appRoot, 'artifacts', 'jitter-probe.json');
}
