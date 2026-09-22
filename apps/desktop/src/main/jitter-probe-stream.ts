/**
 * Default streaming pass: enter a long session that is STILL STREAMING and
 * measure per-frame bottom stability of the followed transcript, the
 * completion settlement, and the cold/warm scroll-to-top passes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrowserWindow } from 'electron';
import { assistantMarkdown, paragraph, probeItems } from './jitter-probe-fixtures';

interface StreamProbeDeps {
  window: BrowserWindow;
  baseSnapshot: Record<string, unknown>;
  prepareRemoteResume(stored: Record<string, unknown>, live: Record<string, unknown>): void;
  send(state: Record<string, unknown>): void;
  outPath: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runStreamingProbe({
  window,
  baseSnapshot,
  prepareRemoteResume,
  send,
  outPath,
}: StreamProbeDeps): Promise<{ reversals: number }> {
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
  const ownerItems = () =>
    items.map((item, index) => (index >= OWNER_REMAP_FROM ? { ...item, id: `own-${String(item.id)}` } : item));

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
  const finishStart = (await window.webContents.executeJavaScript('window.__jitter.samples.length')) as number;
  const completedVisibleTailIndex = (await window.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('.transcript-live-part')?.closest('.transcript-virtual-row');
    const index = row?.getAttribute('data-index');
    return index == null ? null : Number(index);
  })()`)) as number | null;
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
    '(() => { const w = window; cancelAnimationFrame(w.__jitter.raf); return w.__jitter.samples.length; })()'
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
    items: [...ownerItems(), { ...tail(), streaming: false }],
    streamingTail: null,
  });
  await sleep(600);
  const scrollPasses = (await window.webContents.executeJavaScript(`(async () => {
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
  })()`)) as {
    pass1: Record<string, number>;
    pass2: Record<string, number>;
    diag: Record<string, number | null>;
  } | null;

  const report = (await window.webContents.executeJavaScript('window.__jitter.samples')) as Array<{
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
  const firstTailFrame = report.findIndex((sample, index) => index < finishStart && sample.tailIndex != null);
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
  const finishTailTops = finish.map((sample) => sample.tailTop).filter((value): value is number => value != null);
  const finishBodyBottoms = finish
    .map((sample) => sample.tailBodyBottom)
    .filter((value): value is number => value != null);
  const finishMaxTailShift =
    finishTailTops.length > 0 ? Math.max(...finishTailTops) - Math.min(...finishTailTops) : Number.MAX_SAFE_INTEGER;
  const finishMaxBodyShift =
    finishBodyBottoms.length > 0
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
      (sample) => sample.tailIndex != null && sample.tailIndex !== completedVisibleTailIndex
    ).length,
    scrollToTopPass1: scrollPasses?.pass1 ?? null,
    scrollToTopPass2: scrollPasses?.pass2 ?? null,
    scrollToTopDiag: scrollPasses?.diag ?? null,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        summary,
        samples: report,
      },
      null,
      1
    )
  );
  console.log(`[jitter-probe] ${JSON.stringify(summary)}`);
  return summary;
}
