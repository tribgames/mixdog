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

interface ProbeDeps {
  window: BrowserWindow;
  stateChannel: string;
  baseSnapshot: Record<string, unknown>;
  prepareRemoteResume(
    stored: Record<string, unknown>,
    live: Record<string, unknown>,
  ): void;
  outPath: string;
}

const WORDS = ['transcript', 'virtualizer', 'anchors', 'the', 'bottom', 'while',
  'markdown', 'reflows', 'and', 'tool', 'cards', 'append', 'mid', 'stream'];

function paragraph(seed: number, sentences: number): string {
  let out = '';
  for (let s = 0; s < sentences; s++) {
    const length = 6 + ((seed * 7 + s * 13) % 14);
    const words: string[] = [];
    for (let w = 0; w < length; w++) words.push(WORDS[(seed + s * 5 + w * 3) % WORDS.length]);
    out += `${words.join(' ')}. `;
  }
  return out.trim();
}

function assistantMarkdown(seed: number): string {
  // Vary shape hard so row-height ESTIMATES are wrong in both directions:
  // short one-liners, long prose, lists, and code fences.
  const kind = seed % 4;
  if (kind === 0) return paragraph(seed, 1);
  if (kind === 1) return `${paragraph(seed, 4)}\n\n${paragraph(seed + 1, 5)}`;
  if (kind === 2) {
    return `${paragraph(seed, 2)}\n\n${Array.from({ length: 5 }, (_, i) => `- item ${i}: ${paragraph(seed + i, 1)}`).join('\n')}`;
  }
  return `${paragraph(seed, 2)}\n\n\`\`\`ts\n${Array.from({ length: 8 + (seed % 9) }, (_, i) => `const line${i} = probe(${seed}, ${i});`).join('\n')}\n\`\`\``;
}

function probeItems(count: number): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count; i += 2) {
    items.push({ id: `probe-user-${i}`, kind: 'user', text: `probe question ${i}: ${paragraph(i, 1)}` });
    items.push({ id: `probe-assistant-${i}`, kind: 'assistant', text: assistantMarkdown(i) });
  }
  return items;
}

export async function runJitterProbe({
  window,
  stateChannel,
  baseSnapshot,
  prepareRemoteResume,
  outPath,
}: ProbeDeps): Promise<{ reversals: number }> {
  const send = (state: Record<string, unknown>) => {
    window.webContents.send(stateChannel, state);
  };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // The workspace renders the ACTIVE TAB's route; open a task tab first (same
  // precondition as the tool-showcase pass) so pushed snapshots hit the
  // visible transcript.
  await window.webContents.executeJavaScript(`(async () => {
    const link = document.querySelector('.sidebar-primary-nav .task-link');
    if (!(link instanceof HTMLElement)) throw new Error('Missing capture element: .task-link');
    link.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    return true;
  })()`);

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

  // Install the per-frame sampler BEFORE entering the streaming session.
  await window.webContents.executeJavaScript(`(() => {
    const w = window;
    w.__jitter = { samples: [], raf: 0 };
    const sample = () => {
      const el = document.querySelector('.transcript');
      if (el) {
        const box = el.getBoundingClientRect();
        const tail = el.querySelector('.transcript-virtual-row--tail');
        const thread = el.querySelector('.thread');
        w.__jitter.samples.push({
          t: Math.round(performance.now()),
          st: Math.round(el.scrollTop),
          dist: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
          tailTop: tail ? Math.round(tail.getBoundingClientRect().bottom - box.bottom) : null,
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
  // turn and streaming tail. CaptureEngineHost holds the former and resolves
  // resume with the latter, matching the real live-share entry barrier.
  const items = probeItems(88);
  items[60] = {
    ...items[60],
    text: `${String(items[60]?.text || '')} probe persisted last user`,
  };
  let tailText = assistantMarkdown(97);
  const tail = () => ({ id: 'probe-tail', kind: 'assistant', text: tailText, streaming: true });
  const sessionB = () => ({
    ...baseSnapshot,
    toasts: [],
    sessionId: 'probe_session_b',
    busy: true,
    spinner: { label: 'Wrapping' },
    items,
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

  const report = await window.webContents.executeJavaScript(`(() => {
    const w = window;
    cancelAnimationFrame(w.__jitter.raf);
    return w.__jitter.samples;
  })()`) as Array<{
    t: number;
    st: number;
    dist: number;
    tailTop: number | null;
    th: number;
    partialVisible: boolean;
  }>;

  // Metrics over the streaming window (skip the first 5 frames of entry).
  const active = report.slice(5);
  let reversals = 0;
  let maxSwing = 0;
  let lastDelta = 0;
  for (let i = 1; i < active.length; i++) {
    const prev = active[i - 1];
    const next = active[i];
    if (prev.tailTop == null || next.tailTop == null) continue;
    const delta = next.tailTop - prev.tailTop;
    if (Math.abs(delta) > 3 && Math.abs(lastDelta) > 3 && Math.sign(delta) !== Math.sign(lastDelta)) {
      reversals += 1;
      maxSwing = Math.max(maxSwing, Math.abs(delta) + Math.abs(lastDelta));
    }
    if (Math.abs(delta) > 3) lastDelta = delta;
  }
  const distances = active.map((sample) => sample.dist);
  const summary = {
    frames: active.length,
    reversals,
    maxSwing,
    maxDistance: Math.max(...distances),
    meanDistance: Math.round(distances.reduce((a, b) => a + b, 0) / Math.max(1, distances.length)),
    offBottomFrames: distances.filter((d) => d > 8).length,
    partialFrames: report.filter((sample) => sample.partialVisible).length,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ summary, samples: report }, null, 1));
  console.log(`[jitter-probe] ${JSON.stringify(summary)}`);
  return summary;
}

export function jitterProbeOutPath(appRoot: string): string {
  return join(appRoot, 'artifacts', 'jitter-probe.json');
}
