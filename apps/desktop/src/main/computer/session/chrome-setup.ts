/**
 * Chrome remote-debugging setup: the one flow that drives Chrome's own settings
 * UI so Browser Use can attach. It is Computer Use only in the sense that it
 * uses the same host to click; keeping it here leaves the host itself about the
 * desktop contract. It takes exactly what it needs from the host and nothing
 * else, so it can be reasoned about without a live session.
 */
import {
  chromeOwnedConsentAllowRef,
  chromeNativeAddressField,
  chromeSetupControl,
  CHROME_REMOTE_DEBUGGING_URL,
} from '../../browser/chrome-uia';
import type { ComputerWindowRecord } from '../shared/window-transition';
import type { ComputerCommand, ComputerCommandResult, ComputerElementRecord } from '../shared/types';

export interface ChromeRemoteDebuggingTarget {
  windowId: string;
  pid: number;
}

export interface ChromeRemoteDebuggingSetup extends ChromeRemoteDebuggingTarget {
  openedSetupPage: boolean;
  enabledByMixdog: boolean;
}

/** The session this flow runs under, so the host can exempt its own setup work
 *  from the rules that apply to agent-driven Computer Use. */
export const CHROME_SETUP_SESSION_ID = '__mixdog_browser_chrome_setup__';

export interface ChromeRemoteDebuggingHost {
  executeSerialized(command: ComputerCommand): Promise<ComputerCommandResult>;
  /** Keep an internal command from returning an automatic fresh capture. */
  suppressCaptureAfter(command: ComputerCommand): void;
  readComputerWindows(command: ComputerCommand, includeApp?: boolean): Promise<ComputerWindowRecord[] | null>;
  normalizeElementRecords(value: unknown): ComputerElementRecord[];
}

/** Every step reads the same result shape: a JSON object on the command's text. */
function parseComputerPayload(result: ComputerCommandResult): Record<string, unknown> {
  const parsed = JSON.parse(result.text) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Computer Use returned an invalid Chrome setup result.');
  }
  return parsed as Record<string, unknown>;
}

/** Elements of the capture a command carried, or of the command's own result
 *  when it carried none. */
function payloadElements(host: ChromeRemoteDebuggingHost, payload: Record<string, unknown>): ComputerElementRecord[] {
  const captureAfter = payload.capture_after;
  const source = captureAfter && typeof captureAfter === 'object' ? (captureAfter as Record<string, unknown>) : payload;
  return host.normalizeElementRecords(source.elements);
}

/** A real Chrome top-level surface, by process name and window class. */
function isChromeSurface(window: ComputerWindowRecord): boolean {
  return /^chrome$/i.test(window.app) && /^Chrome_WidgetWin_/i.test(window.className);
}

/** The window list this flow judges every target against: read-only, taken
 *  under the setup session, and including this app's own windows. */
function listChromeSetupWindows(host: ChromeRemoteDebuggingHost): Promise<ComputerWindowRecord[] | null> {
  return host.readComputerWindows(
    {
      action: 'list_windows',
      session_id: CHROME_SETUP_SESSION_ID,
      read_only: true,
    },
    true
  );
}

/** The approved window must still be the same window before anything is sent
 *  to it: a Chrome that restarted underneath us owns a different one. */
async function proveChromeRemoteDebuggingTarget(
  host: ChromeRemoteDebuggingHost,
  target: ChromeRemoteDebuggingTarget
): Promise<ComputerWindowRecord> {
  const windows = await listChromeSetupWindows(host);
  const exact = windows?.find(
    (window) => window.id === target.windowId && window.pid === target.pid && isChromeSurface(window)
  );
  if (!exact) {
    throw new Error('The approved Chrome window changed before Browser Use could connect.');
  }
  return exact;
}

/** The same proof for a surface the approved window owns (its consent dialog). */
async function proveChromeRemoteDebuggingSurface(
  host: ChromeRemoteDebuggingHost,
  target: ChromeRemoteDebuggingTarget,
  surfaceWindowId: string
): Promise<ComputerWindowRecord> {
  const windows = await listChromeSetupWindows(host);
  const exact = windows?.find(
    (window) =>
      window.id === surfaceWindowId &&
      window.pid === target.pid &&
      isChromeSurface(window) &&
      (window.id === target.windowId || window.ownerId === target.windowId)
  );
  if (!exact) {
    throw new Error('The approved Chrome surface changed before Browser Use could connect.');
  }
  return exact;
}

/** Which live Chrome window this flow would drive: the focused visible one,
 *  else any visible one, else a minimized fallback. */
async function inspectChromeRemoteDebuggingTarget(
  host: ChromeRemoteDebuggingHost
): Promise<ChromeRemoteDebuggingTarget> {
  const windows = await listChromeSetupWindows(host);
  const candidates = (windows || []).filter((window) => isChromeSurface(window) && window.pid > 0);
  const visible = candidates.filter((window) => !window.minimized && window.width > 0 && window.height > 0);
  const target =
    visible.find((window) => window.focused) ||
    visible[0] ||
    candidates.find((window) => window.focused) ||
    candidates[0];
  if (!target) {
    throw new Error('Open Chrome before connecting a logged-in tab.');
  }
  return { windowId: target.id, pid: target.pid };
}

/** An accessibility capture of a proven surface. */
async function captureChromeSetup(
  host: ChromeRemoteDebuggingHost,
  target: ChromeRemoteDebuggingTarget,
  surfaceWindowId = target.windowId
): Promise<{
  payload: Record<string, unknown>;
  elements: ComputerElementRecord[];
}> {
  await proveChromeRemoteDebuggingSurface(host, target, surfaceWindowId);
  const payload = parseComputerPayload(
    await host.executeSerialized({
      action: 'capture',
      window_id: surfaceWindowId,
      mode: 'ax',
      visible_only: true,
      include_noninteractive: true,
      include_structure: true,
      max_elements: 1_000,
      session_id: CHROME_SETUP_SESSION_ID,
      read_only: true,
    })
  );
  return { payload, elements: payloadElements(host, payload) };
}

/** Drives Chrome's own UI to the setup page: new tab, exact URL into the
 *  native address field, Enter. Returns the control that page carries. */
async function openChromeSetupPage(
  host: ChromeRemoteDebuggingHost,
  target: ChromeRemoteDebuggingTarget
): Promise<NonNullable<ReturnType<typeof chromeSetupControl>>> {
  const opened = parseComputerPayload(
    await host.executeSerialized({
      action: 'key',
      window_id: target.windowId,
      keys: '^t',
      delivery: 'foreground',
      include_noninteractive: true,
      include_structure: true,
      capture_after: true,
      capture_after_mode: 'ax',
      capture_after_max_elements: 1_000,
      session_id: CHROME_SETUP_SESSION_ID,
    })
  );
  const openedAddress = chromeNativeAddressField(payloadElements(host, opened));
  const addressed = parseComputerPayload(
    await host.executeSerialized({
      action: 'set_value',
      window_id: target.windowId,
      ref: openedAddress.ref,
      text: CHROME_REMOTE_DEBUGGING_URL,
      delivery: 'background',
      include_noninteractive: true,
      include_structure: true,
      capture_after: true,
      capture_after_mode: 'ax',
      capture_after_max_elements: 1_000,
      session_id: CHROME_SETUP_SESSION_ID,
    })
  );
  const exactAddress = chromeNativeAddressField(payloadElements(host, addressed));
  if (exactAddress.value.toLowerCase() !== CHROME_REMOTE_DEBUGGING_URL.toLowerCase()) {
    throw new Error('Chrome native address field did not retain the exact setup URL.');
  }
  const navigated = parseComputerPayload(
    await host.executeSerialized({
      action: 'key',
      window_id: target.windowId,
      ref: exactAddress.ref,
      keys: '{ENTER}',
      delivery: 'foreground',
      include_noninteractive: true,
      include_structure: true,
      capture_after: true,
      capture_delay_ms: 1_200,
      capture_after_mode: 'ax',
      capture_after_max_elements: 1_000,
      session_id: CHROME_SETUP_SESSION_ID,
    })
  );
  const control = chromeSetupControl(payloadElements(host, navigated));
  if (!control) {
    throw new Error('Chrome remote-debugging setup did not become ready.');
  }
  return control;
}

/** The setup control, from the page already open or from one opened here. */
async function ensureChromeSetupPage(
  host: ChromeRemoteDebuggingHost,
  target: ChromeRemoteDebuggingTarget
): Promise<{
  control: ReturnType<typeof chromeSetupControl>;
  openedSetupPage: boolean;
}> {
  const initial = await captureChromeSetup(host, target);
  const existing = chromeSetupControl(initial.elements);
  if (existing) return { control: existing, openedSetupPage: false };
  return { control: await openChromeSetupPage(host, target), openedSetupPage: true };
}

/** Brings the setting to the requested state and proves it took. */
async function setChromeRemoteDebugging(
  host: ChromeRemoteDebuggingHost,
  target: ChromeRemoteDebuggingTarget,
  desiredEnabled: boolean
): Promise<{
  openedSetupPage: boolean;
  changed: boolean;
}> {
  const setupPage = await ensureChromeSetupPage(host, target);
  if (!setupPage.control) {
    throw new Error('Chrome remote-debugging setup control is unavailable.');
  }
  if (setupPage.control.enabled === desiredEnabled) {
    return { openedSetupPage: setupPage.openedSetupPage, changed: false };
  }
  const toggled = parseComputerPayload(
    await host.executeSerialized({
      action: 'toggle',
      window_id: target.windowId,
      ref: setupPage.control.ref,
      delivery: 'background',
      include_noninteractive: true,
      include_structure: true,
      capture_after: true,
      capture_after_mode: 'ax',
      capture_after_max_elements: 1_000,
      session_id: CHROME_SETUP_SESSION_ID,
    })
  );
  const verified = chromeSetupControl(payloadElements(host, toggled));
  if (!verified || verified.enabled !== desiredEnabled) {
    throw new Error('Chrome remote-debugging setup control did not retain the requested state.');
  }
  return { openedSetupPage: setupPage.openedSetupPage, changed: true };
}

/** Closes only a tab this flow opened, and only while it still shows the page. */
async function closeChromeSetupPage(
  host: ChromeRemoteDebuggingHost,
  target: ChromeRemoteDebuggingTarget,
  openedSetupPage: boolean
): Promise<void> {
  if (!openedSetupPage) return;
  const capture = await captureChromeSetup(host, target);
  if (!chromeSetupControl(capture.elements)) return;
  await host.executeSerialized({
    action: 'key',
    window_id: target.windowId,
    keys: '^w',
    delivery: 'foreground',
    session_id: CHROME_SETUP_SESSION_ID,
  });
}

/** The setup session holds host resources; it is released on every exit path. */
function releaseChromeSetupSession(host: ChromeRemoteDebuggingHost): Promise<ComputerCommandResult> {
  return host.executeSerialized({
    action: 'session_release',
    session_id: CHROME_SETUP_SESSION_ID,
  });
}

async function prepareChromeRemoteDebugging(
  host: ChromeRemoteDebuggingHost,
  target: ChromeRemoteDebuggingTarget
): Promise<ChromeRemoteDebuggingSetup> {
  const result = await setChromeRemoteDebugging(host, target, true);
  return {
    ...target,
    openedSetupPage: result.openedSetupPage,
    enabledByMixdog: result.changed,
  };
}

/** The one consent dialog the approved window owns, if it is on screen. More
 *  than one owned window means this flow cannot say which prompt is Chrome's. */
async function chromeOwnedConsentPrompt(
  host: ChromeRemoteDebuggingHost,
  setup: ChromeRemoteDebuggingSetup
): Promise<ComputerWindowRecord | undefined> {
  const windows = await listChromeSetupWindows(host);
  const ownedDialogs = (windows || []).filter(
    (window) =>
      window.pid === setup.pid &&
      window.ownerId === setup.windowId &&
      isChromeSurface(window) &&
      !window.minimized &&
      window.width > 0 &&
      window.height > 0
  );
  if (ownedDialogs.length > 1) {
    throw new Error('Chrome exposed multiple owned windows while remote-debugging consent was pending.');
  }
  return ownedDialogs[0];
}

/** The prompt must be gone before consent counts as accepted: an allow action
 *  that left it standing did not do what it claimed. */
async function awaitConsentPromptDismissal(
  host: ChromeRemoteDebuggingHost,
  setup: ChromeRemoteDebuggingSetup,
  promptWindowId: string
): Promise<boolean> {
  const dismissalDeadline = Date.now() + 2_000;
  while (Date.now() < dismissalDeadline) {
    const remaining = await listChromeSetupWindows(host);
    if (!remaining?.some((window) => window.id === promptWindowId && window.pid === setup.pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error('Chrome remote-debugging consent remained after its exact allow action.');
}

async function acceptChromeRemoteDebuggingConsent(
  host: ChromeRemoteDebuggingHost,
  setup: ChromeRemoteDebuggingSetup,
  signal?: AbortSignal
): Promise<boolean> {
  const deadline = Date.now() + 4_000;
  while (!signal?.aborted && Date.now() < deadline) {
    await proveChromeRemoteDebuggingTarget(host, setup);
    const prompt = await chromeOwnedConsentPrompt(host, setup);
    if (!prompt) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      continue;
    }
    const capture = await captureChromeSetup(host, setup, prompt.id);
    const allowRef = chromeOwnedConsentAllowRef(capture.elements);
    if (allowRef) {
      const invokeCommand: ComputerCommand = {
        action: 'invoke',
        window_id: prompt.id,
        ref: allowRef,
        delivery: 'background',
        session_id: CHROME_SETUP_SESSION_ID,
      };
      host.suppressCaptureAfter(invokeCommand);
      await host.executeSerialized(invokeCommand);
      return await awaitConsentPromptDismissal(host, setup, prompt.id);
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return false;
}

async function finalizeChromeRemoteDebuggingSetup(
  host: ChromeRemoteDebuggingHost,
  setup: ChromeRemoteDebuggingSetup
): Promise<void> {
  try {
    await closeChromeSetupPage(host, setup, setup.openedSetupPage);
  } finally {
    await releaseChromeSetupSession(host);
  }
}

async function releaseChromeRemoteDebugging(
  host: ChromeRemoteDebuggingHost,
  setup: ChromeRemoteDebuggingSetup
): Promise<void> {
  let openedSetupPage = false;
  try {
    if (setup.enabledByMixdog) {
      const result = await setChromeRemoteDebugging(host, setup, false);
      openedSetupPage = result.openedSetupPage;
    }
    await closeChromeSetupPage(host, setup, openedSetupPage);
  } finally {
    await releaseChromeSetupSession(host);
  }
}

/** Binds the flow to one host: discovery, enabling, consent, and both exits. */
export function createChromeRemoteDebuggingSetup(host: ChromeRemoteDebuggingHost) {
  return {
    inspectChromeRemoteDebuggingTarget: (): Promise<ChromeRemoteDebuggingTarget> =>
      inspectChromeRemoteDebuggingTarget(host),
    prepareChromeRemoteDebugging: (target: ChromeRemoteDebuggingTarget): Promise<ChromeRemoteDebuggingSetup> =>
      prepareChromeRemoteDebugging(host, target),
    acceptChromeRemoteDebuggingConsent: (setup: ChromeRemoteDebuggingSetup, signal?: AbortSignal): Promise<boolean> =>
      acceptChromeRemoteDebuggingConsent(host, setup, signal),
    finalizeChromeRemoteDebuggingSetup: (setup: ChromeRemoteDebuggingSetup): Promise<void> =>
      finalizeChromeRemoteDebuggingSetup(host, setup),
    releaseChromeRemoteDebugging: (setup: ChromeRemoteDebuggingSetup): Promise<void> =>
      releaseChromeRemoteDebugging(host, setup),
  };
}
