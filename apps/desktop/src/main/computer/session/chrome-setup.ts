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
import type {
  ComputerCommand,
  ComputerCommandResult,
  ComputerElementRecord,
} from '../shared/types';

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
  readComputerWindows(
    command: ComputerCommand,
    includeApp?: boolean,
  ): Promise<ComputerWindowRecord[] | null>;
  normalizeElementRecords(value: unknown): ComputerElementRecord[];
}

export function createChromeRemoteDebuggingSetup(host: ChromeRemoteDebuggingHost) {
  const {
    executeSerialized,
    readComputerWindows,
    normalizeElementRecords,
    suppressCaptureAfter,
  } = host;

  function parseComputerPayload(result: ComputerCommandResult): Record<string, unknown> {
    const parsed = JSON.parse(result.text) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Computer Use returned an invalid Chrome setup result.');
    }
    return parsed as Record<string, unknown>;
  }

  function payloadElements(payload: Record<string, unknown>): ComputerElementRecord[] {
    const captureAfter = payload.capture_after;
    const source = captureAfter && typeof captureAfter === 'object'
      ? captureAfter as Record<string, unknown>
      : payload;
    return normalizeElementRecords(source.elements);
  }

  async function proveChromeRemoteDebuggingTarget(
    target: ChromeRemoteDebuggingTarget,
  ): Promise<ComputerWindowRecord> {
    const windows = await readComputerWindows({
      action: 'list_windows',
      session_id: CHROME_SETUP_SESSION_ID,
      read_only: true,
    }, true);
    const exact = windows?.find((window) =>
      window.id === target.windowId
      && window.pid === target.pid
      && /^chrome$/i.test(window.app)
      && /^Chrome_WidgetWin_/i.test(window.className));
    if (!exact) {
      throw new Error('The approved Chrome window changed before Browser Use could connect.');
    }
    return exact;
  }

  async function proveChromeRemoteDebuggingSurface(
    target: ChromeRemoteDebuggingTarget,
    surfaceWindowId: string,
  ): Promise<ComputerWindowRecord> {
    const windows = await readComputerWindows({
      action: 'list_windows',
      session_id: CHROME_SETUP_SESSION_ID,
      read_only: true,
    }, true);
    const exact = windows?.find((window) =>
      window.id === surfaceWindowId
      && window.pid === target.pid
      && /^chrome$/i.test(window.app)
      && /^Chrome_WidgetWin_/i.test(window.className)
      && (window.id === target.windowId || window.ownerId === target.windowId));
    if (!exact) {
      throw new Error('The approved Chrome surface changed before Browser Use could connect.');
    }
    return exact;
  }

  async function inspectChromeRemoteDebuggingTarget(): Promise<ChromeRemoteDebuggingTarget> {
    const windows = await readComputerWindows({
      action: 'list_windows',
      session_id: CHROME_SETUP_SESSION_ID,
      read_only: true,
    }, true);
    const candidates = (windows || []).filter((window) =>
      /^chrome$/i.test(window.app)
      && /^Chrome_WidgetWin_/i.test(window.className)
      && window.pid > 0);
    const visible = candidates.filter((window) =>
      !window.minimized && window.width > 0 && window.height > 0);
    const target = visible.find((window) => window.focused)
      || visible[0]
      || candidates.find((window) => window.focused)
      || candidates[0];
    if (!target) {
      throw new Error('Open Chrome before connecting a logged-in tab.');
    }
    return { windowId: target.id, pid: target.pid };
  }

  async function captureChromeSetup(
    target: ChromeRemoteDebuggingTarget,
    surfaceWindowId = target.windowId,
  ): Promise<{
    payload: Record<string, unknown>;
    elements: ComputerElementRecord[];
  }> {
    await proveChromeRemoteDebuggingSurface(target, surfaceWindowId);
    const payload = parseComputerPayload(await executeSerialized({
      action: 'capture',
      window_id: surfaceWindowId,
      mode: 'ax',
      visible_only: true,
      include_noninteractive: true,
      include_structure: true,
      max_elements: 1_000,
      session_id: CHROME_SETUP_SESSION_ID,
      read_only: true,
    }));
    return { payload, elements: payloadElements(payload) };
  }

  async function ensureChromeSetupPage(
    target: ChromeRemoteDebuggingTarget,
  ): Promise<{
    control: ReturnType<typeof chromeSetupControl>;
    openedSetupPage: boolean;
  }> {
    const initial = await captureChromeSetup(target);
    const existing = chromeSetupControl(initial.elements);
    if (existing) return { control: existing, openedSetupPage: false };
    const opened = parseComputerPayload(await executeSerialized({
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
    }));
    const openedAddress = chromeNativeAddressField(payloadElements(opened));
    const addressed = parseComputerPayload(await executeSerialized({
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
    }));
    const exactAddress = chromeNativeAddressField(payloadElements(addressed));
    if (exactAddress.value.toLowerCase() !== CHROME_REMOTE_DEBUGGING_URL.toLowerCase()) {
      throw new Error('Chrome native address field did not retain the exact setup URL.');
    }
    const navigated = parseComputerPayload(await executeSerialized({
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
    }));
    const control = chromeSetupControl(payloadElements(navigated));
    if (!control) {
      throw new Error('Chrome remote-debugging setup did not become ready.');
    }
    return { control, openedSetupPage: true };
  }

  async function setChromeRemoteDebugging(
    target: ChromeRemoteDebuggingTarget,
    desiredEnabled: boolean,
  ): Promise<{
    openedSetupPage: boolean;
    changed: boolean;
  }> {
    const setupPage = await ensureChromeSetupPage(target);
    if (!setupPage.control) {
      throw new Error('Chrome remote-debugging setup control is unavailable.');
    }
    if (setupPage.control.enabled === desiredEnabled) {
      return { openedSetupPage: setupPage.openedSetupPage, changed: false };
    }
    const toggled = parseComputerPayload(await executeSerialized({
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
    }));
    const verified = chromeSetupControl(payloadElements(toggled));
    if (!verified || verified.enabled !== desiredEnabled) {
      throw new Error('Chrome remote-debugging setup control did not retain the requested state.');
    }
    return { openedSetupPage: setupPage.openedSetupPage, changed: true };
  }

  async function closeChromeSetupPage(
    target: ChromeRemoteDebuggingTarget,
    openedSetupPage: boolean,
  ): Promise<void> {
    if (!openedSetupPage) return;
    const capture = await captureChromeSetup(target);
    if (!chromeSetupControl(capture.elements)) return;
    await executeSerialized({
      action: 'key',
      window_id: target.windowId,
      keys: '^w',
      delivery: 'foreground',
      session_id: CHROME_SETUP_SESSION_ID,
    });
  }

  async function prepareChromeRemoteDebugging(
    target: ChromeRemoteDebuggingTarget,
  ): Promise<ChromeRemoteDebuggingSetup> {
    const result = await setChromeRemoteDebugging(target, true);
    return {
      ...target,
      openedSetupPage: result.openedSetupPage,
      enabledByMixdog: result.changed,
    };
  }

  async function acceptChromeRemoteDebuggingConsent(
    setup: ChromeRemoteDebuggingSetup,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const deadline = Date.now() + 4_000;
    while (!signal?.aborted && Date.now() < deadline) {
      await proveChromeRemoteDebuggingTarget(setup);
      const windows = await readComputerWindows({
        action: 'list_windows',
        session_id: CHROME_SETUP_SESSION_ID,
        read_only: true,
      }, true);
      const ownedDialogs = (windows || []).filter((window) =>
        window.pid === setup.pid
        && window.ownerId === setup.windowId
        && /^chrome$/i.test(window.app)
        && /^Chrome_WidgetWin_/i.test(window.className)
        && !window.minimized
        && window.width > 0
        && window.height > 0);
      if (ownedDialogs.length > 1) {
        throw new Error('Chrome exposed multiple owned windows while remote-debugging consent was pending.');
      }
      const prompt = ownedDialogs[0];
      if (!prompt) {
        await new Promise((resolve) => setTimeout(resolve, 80));
        continue;
      }
      const capture = await captureChromeSetup(setup, prompt.id);
      const allowRef = chromeOwnedConsentAllowRef(capture.elements);
      if (allowRef) {
        const invokeCommand: ComputerCommand = {
          action: 'invoke',
          window_id: prompt.id,
          ref: allowRef,
          delivery: 'background',
          session_id: CHROME_SETUP_SESSION_ID,
        };
        suppressCaptureAfter(invokeCommand);
        await executeSerialized(invokeCommand);
        const dismissalDeadline = Date.now() + 2_000;
        while (Date.now() < dismissalDeadline) {
          const remaining = await readComputerWindows({
            action: 'list_windows',
            session_id: CHROME_SETUP_SESSION_ID,
            read_only: true,
          }, true);
          if (!remaining?.some((window) => window.id === prompt.id && window.pid === setup.pid)) {
            return true;
          }
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        throw new Error('Chrome remote-debugging consent remained after its exact allow action.');
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    return false;
  }

  async function finalizeChromeRemoteDebuggingSetup(
    setup: ChromeRemoteDebuggingSetup,
  ): Promise<void> {
    try {
      await closeChromeSetupPage(setup, setup.openedSetupPage);
    } finally {
      await executeSerialized({
        action: 'session_release',
        session_id: CHROME_SETUP_SESSION_ID,
      });
    }
  }

  async function releaseChromeRemoteDebugging(
    setup: ChromeRemoteDebuggingSetup,
  ): Promise<void> {
    let openedSetupPage = false;
    try {
      if (setup.enabledByMixdog) {
        const result = await setChromeRemoteDebugging(setup, false);
        openedSetupPage = result.openedSetupPage;
      }
      await closeChromeSetupPage(setup, openedSetupPage);
    } finally {
      await executeSerialized({
        action: 'session_release',
        session_id: CHROME_SETUP_SESSION_ID,
      });
    }
  }

  return {
    inspectChromeRemoteDebuggingTarget,
    prepareChromeRemoteDebugging,
    acceptChromeRemoteDebuggingConsent,
    finalizeChromeRemoteDebuggingSetup,
    releaseChromeRemoteDebugging,
  };
}
