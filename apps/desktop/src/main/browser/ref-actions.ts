/**
 * Every gesture that addresses one element by ref: filling and typing, both
 * kinds of dropdown, checkbox state, and file upload. Each one runs the same
 * two-step contract — reach the element through the accessibility snapshot,
 * fall back to the page-side ref table, and report what the element actually
 * holds afterwards. The host keeps the tab graph; this keeps the gestures.
 */
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import type { WebContents } from 'electron';

import type { BrowserCdpPort } from './cdp';
import type { PendingFileChooser } from './guest-state';
import type { createBrowserInputDriver } from './input';
import { redactBrowserText } from './redaction';
import { BROWSER_EDITABILITY_CHECK } from './editability';
import { createBrowserRefAccess } from './ref-access';
import { createBrowserRefSelection } from './ref-select';

/** How long a clicked button gets to open its picker. */
const FILE_CHOOSER_WAIT_MS = 3_000;
const FILE_CHOOSER_POLL_MS = 50;

export interface BrowserRefActionsHost {
  /** Run a function against the ref through the accessibility snapshot. */
  callAccessibilityRef<T>(
    guest: WebContents,
    ref: string,
    functionDeclaration: string,
    args: unknown[],
    signal?: AbortSignal,
  ): Promise<{ handled: false } | { handled: true; value: T }>;
  /** The page-side fallback for a ref the accessibility snapshot lost. */
  evaluate<T>(guest: WebContents, expression: string, signal?: AbortSignal): Promise<T>;
  cdp: BrowserCdpPort;
  /** The accessibility snapshot's ref table, when this page still has one. */
  accessibilityRefs(guest: WebContents): {
    refs: Map<string, { backendNodeId: number; sessionId?: string }>;
  } | undefined;
  /** Where the ref sits right now, refused when something covers it. */
  resolveRefPoint(
    guest: WebContents,
    ref: string,
    signal?: AbortSignal,
  ): Promise<{ x: number; y: number }>;
  input: Pick<ReturnType<typeof createBrowserInputDriver>, 'pressKey' | 'clickAt'>;
  pause(ms: number, signal?: AbortSignal): Promise<void>;
  /** The picker the page opened and nobody has answered yet. */
  pendingFileChooser(guest: WebContents): PendingFileChooser | null;
  clearFileChooser(guest: WebContents): void;
  /** How long a custom dropdown may take to render its options. */
  dropdownTimeoutMs: number;
  dropdownPollMs: number;
  rememberSecret?(guest: WebContents, value: string): void;
}

export function createBrowserRefActions(host: BrowserRefActionsHost) {
  const {
    callAccessibilityRef,
    accessibilityRefs,
    evaluate,
    cdp,
    resolveRefPoint,
    input: browserInput,
    pause,
    pendingFileChooser,
    clearFileChooser,
  } = host;
  const { prepareRef } = createBrowserRefAccess(host);
  const { selectRef, selectCustomRef } = createBrowserRefSelection(host);
  async function fillRef(
    guest: WebContents,
    ref: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const accessibility = await callAccessibilityRef<{
      error?: string;
      value?: string;
      sensitive?: boolean;
    }>(guest, ref, `function(text) {
      const el = this;
      if (!el || !el.isConnected) return { error: 'stale' };
      const editError = (${BROWSER_EDITABILITY_CHECK})(el);
      if (editError) return { error: editError };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus();
      const tag = (el.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') {
        const type = tag === 'input' ? String(el.type || 'text').toLowerCase() : '';
        if (type === 'file') return { error: 'file inputs require upload' };
        const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (!setter) return { error: 'input value setter is unavailable' };
        setter.call(el, text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { value: type === 'password' ? '' : el.value, sensitive: type === 'password' };
      }
      if (el.isContentEditable) {
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        return { value: text };
      }
      return { error: 'element is not editable' };
    }`, [text], signal);
    const outcome = accessibility.handled
      ? accessibility.value
      : await evaluate<{ error?: string; value?: string; sensitive?: boolean }>(guest, `(() => {
        const record = window.__mixdogAgentSnapshot?.refs?.get(${JSON.stringify(ref)});
        const el = record?.element || record;
        if (!el || !el.isConnected) return { error: 'stale' };
        const editError = (${BROWSER_EDITABILITY_CHECK})(el);
        if (editError) return { error: editError };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.focus();
        const text = ${JSON.stringify(text)};
        const tag = (el.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea') {
          const type = tag === 'input' ? String(el.type || 'text').toLowerCase() : '';
          if (type === 'file') return { error: 'file inputs require upload' };
          const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (!setter) return { error: 'input value setter is unavailable' };
          setter.call(el, text);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { value: type === 'password' ? '' : el.value, sensitive: type === 'password' };
        }
        if (el.isContentEditable) {
          el.textContent = text;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
          return { value: text };
        }
        return { error: 'element is not editable' };
      })()`, signal);
    if (outcome?.error) {
      throw new Error(outcome.error === 'stale'
        ? `ref ${ref} is stale or unknown; take a fresh snapshot first`
        : outcome.error);
    }
    if (outcome?.sensitive && text) host.rememberSecret?.(guest, text);
    return outcome?.sensitive ? '[REDACTED]' : redactBrowserText(outcome?.value ?? '');
  }

  async function typeRef(
    guest: WebContents,
    ref: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const accessibility = await callAccessibilityRef<{ error?: string; sensitive?: boolean }>(guest, ref, `function() {
      const el = this;
      if (!el || !el.isConnected) return { error: 'stale' };
      const editError = (${BROWSER_EDITABILITY_CHECK})(el);
      if (editError) return { error: editError };
      if (!(el.matches?.('input, textarea') || el.isContentEditable)) return { error: 'element is not editable' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus();
      return { sensitive: el.type === 'password' };
    }`, [], signal);
    const focused = accessibility.handled
      ? accessibility.value
      : await evaluate<{ error?: string; sensitive?: boolean }>(guest, `(() => {
        const record = window.__mixdogAgentSnapshot?.refs?.get(${JSON.stringify(ref)});
        const el = record?.element || record;
        if (!el || !el.isConnected) return { error: 'stale' };
        const editError = (${BROWSER_EDITABILITY_CHECK})(el);
        if (editError) return { error: editError };
        if (!(el.matches?.('input, textarea') || el.isContentEditable)) return { error: 'element is not editable' };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.focus();
        return { sensitive: el.type === 'password' };
      })()`, signal);
    if (focused?.error) {
      throw new Error(focused.error === 'stale'
        ? `ref ${ref} is stale or unknown; take a fresh snapshot first`
        : focused.error);
    }
    if (focused?.sensitive && text) host.rememberSecret?.(guest, text);
    await browserInput.pressKey(guest, process.platform === 'darwin' ? 'Meta+A' : 'Control+A', signal);
    await browserInput.pressKey(guest, 'Backspace', signal);
    await cdp.sendCdpInput(guest, await cdp.guestDebugger(guest), 'Input.insertText', { text }, signal);
  }


  /** What a control offers, without choosing anything. A native <select> keeps
   *  its options out of the accessibility tree, so they are read from the
   *  element itself; a custom dropdown puts its options in the page once it is
   *  open, where a snapshot already sees them. */
  async function listSelectOptions(
    guest: WebContents,
    ref: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const read = `function() {
      const el = this;
      if (!el || !el.isConnected) return { error: 'stale' };
      if ((el.tagName || '').toLowerCase() !== 'select') return { custom: true };
      const options = Array.from(
        { length: Math.min(el.options.length, 200) },
        (_, index) => el.options[index],
      )
        .map((option) => String(option.label || option.text || option.value || '').trim().slice(0, 200))
        .filter(Boolean)
        .slice(0, 200);
      return { options };
    }`;
    const accessibility = await callAccessibilityRef<{
      error?: string;
      custom?: boolean;
      options?: string[];
    }>(guest, ref, read, [], signal);
    const result = accessibility.handled
      ? accessibility.value
      : await evaluate<{ error?: string; custom?: boolean; options?: string[] }>(guest, `(() => {
        const record = window.__mixdogAgentSnapshot?.refs?.get(${JSON.stringify(ref)});
        const el = record?.element || record;
        if (!el || !el.isConnected) return { error: 'stale' };
        if ((el.tagName || '').toLowerCase() !== 'select') return { custom: true };
        const options = Array.from(
          { length: Math.min(el.options.length, 200) },
          (_, index) => el.options[index],
        )
          .map((option) => String(option.label || option.text || option.value || '').trim().slice(0, 200))
          .filter(Boolean)
          .slice(0, 200);
        return { options };
      })()`, signal);
    if (result?.error) {
      throw new Error(result.error === 'stale'
        ? `ref ${ref} is stale or unknown; take a fresh snapshot first`
        : result.error);
    }
    if (result?.custom) {
      throw new Error(
        `ref ${ref} is not a native <select>; click it to open the list, then read the options from the fresh snapshot`,
      );
    }
    return result?.options || [];
  }

  async function checkedRefState(
    guest: WebContents,
    ref: string,
    signal?: AbortSignal,
  ): Promise<{ checked: boolean; radio: boolean }> {
    const accessibility = await callAccessibilityRef<{
      error?: string;
      checked?: boolean;
      radio?: boolean;
    }>(guest, ref, `function() {
      const el = this;
      if (!el || !el.isConnected) return { error: 'stale' };
      const tag = (el.tagName || '').toLowerCase();
      const type = String(el.type || '').toLowerCase();
      if (tag !== 'input' || !['checkbox', 'radio'].includes(type)) {
        return { error: 'element is not a checkbox or radio button' };
      }
      return { checked: Boolean(el.checked), radio: type === 'radio' };
    }`, [], signal);
    const state = accessibility.handled
      ? accessibility.value
      : await evaluate<{ error?: string; checked?: boolean; radio?: boolean }>(guest, `(() => {
        const record = window.__mixdogAgentSnapshot?.refs?.get(${JSON.stringify(ref)});
        const el = record?.element || record;
        if (!el || !el.isConnected) return { error: 'stale' };
        const tag = (el.tagName || '').toLowerCase();
        const type = String(el.type || '').toLowerCase();
        if (tag !== 'input' || !['checkbox', 'radio'].includes(type)) {
          return { error: 'element is not a checkbox or radio button' };
        }
        return { checked: Boolean(el.checked), radio: type === 'radio' };
      })()`, signal);
    if (state?.error) {
      throw new Error(state.error === 'stale'
        ? `ref ${ref} is stale or unknown; take a fresh snapshot first`
        : state.error);
    }
    return { checked: state?.checked === true, radio: state?.radio === true };
  }

  async function setCheckedRef(
    guest: WebContents,
    ref: string,
    checked: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const state = await checkedRefState(guest, ref, signal);
    if (state.radio && !checked) throw new Error('radio buttons cannot be unchecked directly; choose another option');
    if (state.checked !== checked) {
      const point = await resolveRefPoint(guest, ref, signal);
      await browserInput.clickAt(guest, point.x, point.y, 1, 'left', 0, signal);
      const finalState = await checkedRefState(guest, ref, signal);
      if (finalState.checked !== checked) {
        throw new Error(
          `check input was dispatched once but the element remained checked=${finalState.checked}; the action was not retried`,
        );
      }
    }
  }

  /** The live DOM object behind a ref: through the accessibility snapshot
   *  when the page still has one, otherwise through the page-side ref table. */
  async function resolveRefObject(
    guest: WebContents,
    ref: string,
    signal?: AbortSignal,
  ): Promise<{ objectId: string; sessionId?: string }> {
    const accessibilitySnapshot = accessibilityRefs(guest);
    if (accessibilitySnapshot) {
      const target = accessibilitySnapshot.refs.get(ref);
      if (!target) throw new Error(`ref ${ref} is stale or unknown; take a fresh snapshot first`);
      const resolved = await cdp.call<{ object?: { objectId?: string } }>(
        guest,
        'DOM.resolveNode',
        { backendNodeId: target.backendNodeId },
        signal,
        { sessionId: target.sessionId },
      );
      const objectId = resolved.object?.objectId;
      if (!objectId) throw new Error(`ref ${ref} is stale or detached; take a fresh snapshot first`);
      return { objectId, sessionId: target.sessionId };
    }
    const response = await cdp.call<{
      result?: { objectId?: string };
      exceptionDetails?: unknown;
    }>(guest, 'Runtime.evaluate', {
      expression: `(() => {
        const record = window.__mixdogAgentSnapshot?.refs?.get(${JSON.stringify(ref)});
        const el = record?.element || record;
        if (!el || !el.isConnected) throw new Error('stale ref');
        return el;
      })()`,
      returnByValue: false,
      userGesture: true,
    }, signal);
    const objectId = response.result?.objectId;
    if (!objectId || response.exceptionDetails) {
      throw new Error(`ref ${ref} is stale or unknown; take a fresh snapshot first`);
    }
    return { objectId };
  }

  async function isFileInput(
    guest: WebContents,
    object: { objectId: string; sessionId?: string },
    signal?: AbortSignal,
  ): Promise<boolean> {
    const validation = await cdp.call<{
      result?: { value?: { valid?: boolean } };
      exceptionDetails?: unknown;
    }>(
      guest,
      'Runtime.callFunctionOn',
      {
        objectId: object.objectId,
        functionDeclaration: `function() {
          return {
            valid: (this.tagName || '').toLowerCase() === 'input'
              && String(this.type || '').toLowerCase() === 'file',
          };
        }`,
        returnByValue: true,
      },
      signal,
      { sessionId: object.sessionId },
    );
    return !validation.exceptionDetails && validation.result?.value?.valid === true;
  }

  /** Hand the approved files to the picker the page opened. */
  async function answerFileChooser(
    guest: WebContents,
    chooser: PendingFileChooser,
    paths: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (!chooser.backendNodeId) {
      clearFileChooser(guest);
      throw new Error('the open file chooser has no target element; take a fresh snapshot and upload by ref');
    }
    if (chooser.mode === 'selectSingle' && paths.length > 1) {
      throw new Error('the open file chooser accepts a single file');
    }
    await cdp.call(
      guest,
      'DOM.setFileInputFiles',
      { files: paths, backendNodeId: chooser.backendNodeId },
      signal,
      { sessionId: chooser.sessionId },
    );
    clearFileChooser(guest);
  }

  /** Click an element that is not itself a file input and wait for the
   *  picker it opens — the common pattern of a styled button over a hidden
   *  input. */
  async function openFileChooserVia(
    guest: WebContents,
    ref: string,
    signal?: AbortSignal,
  ): Promise<PendingFileChooser> {
    clearFileChooser(guest);
    const point = await resolveRefPoint(guest, ref, signal);
    await browserInput.clickAt(guest, point.x, point.y, 1, 'left', 0, signal);
    const deadline = Date.now() + FILE_CHOOSER_WAIT_MS;
    for (;;) {
      const chooser = pendingFileChooser(guest);
      if (chooser) return chooser;
      if (Date.now() >= deadline) {
        throw new Error(
          `ref ${ref} is not a file input and clicking it did not open a file chooser within ${FILE_CHOOSER_WAIT_MS}ms`,
        );
      }
      await pause(FILE_CHOOSER_POLL_MS, signal);
    }
  }

  /** Put files on the page. A file-input ref takes them directly; any other
   *  ref is clicked to open its picker; no ref answers a picker that is
   *  already open. */
  async function uploadRef(
    guest: WebContents,
    ref: string | undefined,
    paths: string[],
    confirmed: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!confirmed) throw new Error('upload requires confirm:true after the user approved the exact absolute paths');
    if (!paths.length || paths.length > 10) throw new Error('upload requires 1–10 file paths');
    for (const path of paths) {
      if (!isAbsolute(path)) throw new Error(`upload path must be absolute: ${path}`);
      const info = await stat(path);
      if (!info.isFile()) throw new Error(`upload path is not a file: ${path}`);
    }
    if (!ref) {
      const chooser = pendingFileChooser(guest);
      if (!chooser) throw new Error('upload requires ref unless the page has opened a file chooser');
      await answerFileChooser(guest, chooser, paths, signal);
      return;
    }
    const object = await resolveRefObject(guest, ref, signal);
    let direct = false;
    try {
      direct = await isFileInput(guest, object, signal);
      if (direct) {
        await cdp.call(
          guest,
          'DOM.setFileInputFiles',
          { files: paths, objectId: object.objectId },
          signal,
          { sessionId: object.sessionId },
        );
      }
    } finally {
      void cdp.guestDebugger(guest)
        .then((debug) => debug.sendCommand('Runtime.releaseObject', { objectId: object.objectId }, object.sessionId))
        .catch(() => undefined);
    }
    if (direct) return;
    const chooser = await openFileChooserVia(guest, ref, signal);
    await answerFileChooser(guest, chooser, paths, signal);
  }

  return {
    prepareRef,
    fillRef,
    typeRef,
    listSelectOptions,
    selectCustomRef,
    selectRef,
    checkedRefState,
    setCheckedRef,
    uploadRef,
  };
}
