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
 *
 * This entry point owns the shared precondition (an open task tab) and the
 * MIXDOG_JITTER_PROBE pass selection; each pass lives in its own module.
 */
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { runEntryProbe } from './jitter-probe-entry';
import { runKeysProbe } from './jitter-probe-keys';
import { runStreamingProbe } from './jitter-probe-stream';
import { runSwitchProbe } from './jitter-probe-switch';
import { runWidthProbe } from './jitter-probe-width';

interface ProbeDeps {
  window: BrowserWindow;
  stateChannel: string;
  baseSnapshot: Record<string, unknown>;
  prepareRemoteResume(stored: Record<string, unknown>, live: Record<string, unknown>): void;
  prepareColdResume(snapshot: Record<string, unknown>): void;
  /** Host publish path (state + per-session channels); the select pass
   *  pushes its fixture through it so the session lane accepts the frame. */
  publish?(snapshot: Record<string, unknown>): void;
  outPath: string;
}

export async function runJitterProbe({
  window,
  stateChannel,
  baseSnapshot,
  prepareRemoteResume,
  prepareColdResume,
  publish,
  outPath,
}: ProbeDeps): Promise<{ reversals: number }> {
  const send = (state: Record<string, unknown>) => {
    window.webContents.send(stateChannel, state);
  };
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
    await window.webContents.executeJavaScript('window.__mixdogMarkdownPreloadDelayMs = 1200; true');
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
      const sidebar = document.querySelector('.sessions-link');
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

  // MIXDOG_JITTER_PROBE=select drives a REAL selection drag out of the
  // transcript (composer, window edges) and reports Selection/focus state.
  if (process.env.MIXDOG_JITTER_PROBE === 'select') {
    const { runSelectionProbe } = await import('./jitter-probe-selection');
    return runSelectionProbe({
      window,
      baseSnapshot,
      prepareColdResume,
      send: publish ?? send,
      outPath,
    });
  }

  if (widthMode) {
    return runWidthProbe({ window, baseSnapshot, prepareColdResume, send, outPath });
  }

  if (switchMode) {
    return runSwitchProbe({ window, outPath });
  }

  if (keysMode) {
    return runKeysProbe({ window, baseSnapshot, prepareColdResume, send, outPath });
  }

  if (entryMode) {
    return runEntryProbe({ window, baseSnapshot, prepareColdResume, send, outPath });
  }

  return runStreamingProbe({ window, baseSnapshot, prepareRemoteResume, send, outPath });
}

export function jitterProbeOutPath(appRoot: string): string {
  return join(appRoot, 'artifacts', 'jitter-probe.json');
}
