/**
 * Rapid session switch pass (MIXDOG_JITTER_PROBE=switch): A→B→C switching,
 * foreground scroll restoration, warm New Task / Studio re-entry, and both
 * side panels' named View Transition handover checks.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrowserWindow } from 'electron';
import {
  beginPaintFrameProbe,
  summarizeWarmPaint,
  type PaintProbeBounds,
  type PaintFrameSample,
} from './jitter-probe-metrics';
import { clickProbeSession, COLLECT_SWITCH_FRAMES_SCRIPT } from './jitter-probe-session';

interface SwitchProbeDeps {
  window: BrowserWindow;
  outPath: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runSwitchProbe({ window, outPath }: SwitchProbeDeps): Promise<{ reversals: number }> {
  const clickSession = (id: string, waitMs: number) => clickProbeSession(window, id, waitMs);
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
  const switchFrames = (await window.webContents.executeJavaScript(COLLECT_SWITCH_FRAMES_SCRIPT)) as Array<{
    t: number;
    title: string;
    transcript: string;
  }>;
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
  const foregroundScroll = (await window.webContents.executeJavaScript(`(async () => {
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
        text: (entry.row.textContent || '').replace(/s+/g, '').slice(0, 120),
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
  })()`)) as {
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
  const warmSetup = (await window.webContents.executeJavaScript(`(async () => {
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
  })()`)) as {
    preflight: Record<string, unknown>;
    paintBounds: PaintProbeBounds;
  };
  const paintProbe = beginPaintFrameProbe(window, warmSetup.paintBounds);
  await sleep(80);
  paintProbe.mark('new-task');
  const parked = (await window.webContents.executeJavaScript(`(async () => {
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
  })()`)) as Record<string, unknown>;
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
    warmResult = (await window.webContents.executeJavaScript(`(async () => {
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
    })()`)) as typeof warmResult;
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
  const studioReentry = (await window.webContents.executeJavaScript(`(async () => {
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
  })()`)) as {
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

  const probePanelToggle = async (selector: string) =>
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
    })()`) as Promise<
      Array<{
        t: number;
        phase: string;
        left: number | null;
        width: number | null;
        animations: number;
      }>
    >;
  const summarizePanel = (samples: Awaited<ReturnType<typeof probePanelToggle>>) => {
    const activeIndexes = samples.map((sample, index) => (sample.phase ? index : -1)).filter((index) => index >= 0);
    const first = samples[0];
    const last = samples.at(-1);
    const lastActiveIndex = activeIndexes.at(-1) ?? -1;
    const anchor = lastActiveIndex >= 0 ? samples[lastActiveIndex] : null;
    const post = lastActiveIndex >= 0 ? samples.slice(lastActiveIndex + 1) : [];
    const delta = (sample: typeof first, other: typeof first) =>
      Math.max(
        Math.abs(Number(sample.left) - Number(other.left)),
        Math.abs(Number(sample.width) - Number(other.width))
      );
    return {
      phase: activeIndexes.length ? samples[activeIndexes[0]].phase : '',
      activeFrames: activeIndexes.length,
      animatedFrames: samples.filter((sample) => sample.phase && sample.animations > 0).length,
      geometryDelta: first && last ? delta(first, last) : 0,
      postHandoverShift: anchor && post.length ? Math.max(...post.map((sample) => delta(anchor, sample))) : 0,
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
  const panelsPass = panels.every((panel) => panel.geometryDelta >= 20 && panel.postHandoverShift <= 1);
  if (
    wrongSessionFrames.length > 0 ||
    finalSwitchFrame?.title !== 'Switch C' ||
    !finalSwitchFrame?.transcript.includes('Switch C transcript') ||
    foregroundScroll.maxWrites > 1 ||
    foregroundScroll.maxTotalWrites > 1 ||
    foregroundScroll.maxScrollDrift > 1 ||
    foregroundScroll.maxFrameScrollDrift > 1 ||
    foregroundScroll.maxAnchorOffsetDrift > 1 ||
    foregroundScroll.missingAnchorFrames > 0 ||
    foregroundScroll.anchorMismatchCount > 0 ||
    warmReentry.frames < 10 ||
    !warmReentry.conversationSame ||
    !warmReentry.scriptSame ||
    warmReentry.maxScrollDrift > 1 ||
    warmReentry.maxSpaceDrift > 1 ||
    warmReentry.missingScriptFrames > 0 ||
    warmReentry.layoutShift > 0.001 ||
    warmReentry.handoffFrames > 1 ||
    warmReentry.firstStableMs === null ||
    warmReentry.firstStableMs > 50 ||
    // Frame subscription reports presentation changes, not idle vsyncs:
    // each static baseline legitimately contributes one compositor frame.
    warmReentry.paint.sessionFrames < 1 ||
    warmReentry.paint.newTaskFrames < 1 ||
    warmReentry.paint.reentryFrames < 2 ||
    warmReentry.paint.maxBrightnessExcursion > 0.06 ||
    warmReentry.paint.firstStablePaintFrame === null ||
    warmReentry.paint.firstStablePaintFrame > 3 ||
    studioReentry.frames < 10 ||
    !studioReentry.conversationSame ||
    !studioReentry.rowSame ||
    !studioReentry.scriptSame ||
    studioReentry.missingRowFrames > 0 ||
    studioReentry.maxRowHeightDrift > 1 ||
    studioReentry.maxScriptHeightDrift > 1 ||
    studioReentry.maxScrollDrift > 1 ||
    studioReentry.maxSpaceDrift > 1 ||
    !panelsPass
  ) {
    throw new Error(`Switch/panel jitter probe failed: ${JSON.stringify(switchSummary)}`);
  }
  return { reversals: 0, ...switchSummary } as unknown as { reversals: number };
}
