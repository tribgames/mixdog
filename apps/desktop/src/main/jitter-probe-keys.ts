/**
 * Keyboard paging pass (MIXDOG_JITTER_PROBE=keys).
 * Space / PageDown at the TOP of a long transcript must move the view down
 * and LEAVE it there. Chrome's own key scrolling animates the container
 * while the virtualizer still holds the pre-key offset, and the following
 * anchor correction used to snap the view straight back up (user report:
 * 최상단에서 스페이스를 누르면 내려갔다가 다시 위로 복귀).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrowserWindow } from 'electron';
import { assistantMarkdown, coldHistoryItems, paragraph } from './jitter-probe-fixtures';

interface KeysProbeDeps {
  window: BrowserWindow;
  baseSnapshot: Record<string, unknown>;
  prepareColdResume(snapshot: Record<string, unknown>): void;
  send(state: Record<string, unknown>): void;
  outPath: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runKeysProbe({
  window,
  baseSnapshot,
  prepareColdResume,
  send,
  outPath,
}: KeysProbeDeps): Promise<{ reversals: number }> {
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
    const before = (await window.webContents.executeJavaScript(`(() => {
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
    })()`)) as {
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
    const samples = (await window.webContents.executeJavaScript(`(() => {
      const w = window;
      cancelAnimationFrame(w.__keys.raf);
      w.__keys.raf = 0;
      return w.__keys.samples;
    })()`)) as Array<{ t: number; st: number }>;
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
    `document.querySelector('.composer textarea, .composer-region textarea, textarea')`
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
    })()`
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
  writeFileSync(
    outPath,
    JSON.stringify(
      {
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
      },
      null,
      1
    )
  );
  console.log(`[jitter-probe] ${JSON.stringify(keysSummary)}`);
  return { reversals: 0, ...keysSummary } as unknown as { reversals: number };
}
