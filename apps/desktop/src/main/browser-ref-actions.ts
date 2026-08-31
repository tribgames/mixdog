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

import { redactBrowserText } from './browser-host-policy';
import type { createBrowserInputDriver } from './browser-input';

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
  guestDebugger(guest: WebContents): Promise<Electron.Debugger>;
  sendCdp<T>(
    guest: WebContents,
    cdp: Electron.Debugger,
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
    sessionId?: string,
  ): Promise<T>;
  sendCdpInput(
    guest: WebContents,
    cdp: Electron.Debugger,
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
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
  cdpTimeoutMs: number;
  /** How long a custom dropdown may take to render its options. */
  dropdownTimeoutMs: number;
  dropdownPollMs: number;
}

export function createBrowserRefActions(host: BrowserRefActionsHost) {
  const {
    callAccessibilityRef,
    accessibilityRefs,
    evaluate,
    guestDebugger,
    sendCdp,
    sendCdpInput,
    resolveRefPoint,
    input: browserInput,
    pause,
    cdpTimeoutMs: CDP_REQUEST_TIMEOUT_MS,
    dropdownTimeoutMs: CUSTOM_DROPDOWN_TIMEOUT_MS,
    dropdownPollMs: CUSTOM_DROPDOWN_POLL_MS,
  } = host;
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
    return outcome?.sensitive ? '[REDACTED]' : redactBrowserText(outcome?.value ?? '');
  }

  async function typeRef(
    guest: WebContents,
    ref: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const accessibility = await callAccessibilityRef<{ error?: string }>(guest, ref, `function() {
      const el = this;
      if (!el || !el.isConnected) return { error: 'stale' };
      if (!(el.matches?.('input, textarea') || el.isContentEditable)) return { error: 'element is not editable' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus();
      return {};
    }`, [], signal);
    const focused = accessibility.handled
      ? accessibility.value
      : await evaluate<{ error?: string }>(guest, `(() => {
        const record = window.__mixdogAgentSnapshot?.refs?.get(${JSON.stringify(ref)});
        const el = record?.element || record;
        if (!el || !el.isConnected) return { error: 'stale' };
        if (!(el.matches?.('input, textarea') || el.isContentEditable)) return { error: 'element is not editable' };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.focus();
        return {};
      })()`, signal);
    if (focused?.error) {
      throw new Error(focused.error === 'stale'
        ? `ref ${ref} is stale or unknown; take a fresh snapshot first`
        : focused.error);
    }
    await browserInput.pressKey(guest, process.platform === 'darwin' ? 'Meta+A' : 'Control+A', signal);
    await browserInput.pressKey(guest, 'Backspace', signal);
    const cdp = await guestDebugger(guest);
    await sendCdpInput(guest, cdp, 'Input.insertText', { text }, signal);
  }

  /** Non-native dropdowns (ARIA combobox/listbox/menu) cannot be assigned like
   *  a <select>: the page owns the popup. Open the trigger, then activate the
   *  option whose text matches — the same two gestures a person performs. */
  async function selectCustomRef(
    guest: WebContents,
    ref: string,
    values: string[],
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (values.length > 1) {
      throw new Error(
        'this control is not a native <select>; custom dropdowns accept exactly one value per select',
      );
    }
    const openScript = `function() {
      const el = this;
      if (!el || !el.isConnected) return { error: 'stale' };
      const target = el.closest('[role="combobox"],[role="listbox"],[aria-haspopup]') || el;
      if (target.getAttribute('aria-expanded') !== 'true') {
        target.scrollIntoView({ block: 'center', behavior: 'instant' });
        target.click();
      }
      return { opened: true };
    }`;
    const opened = await callAccessibilityRef<{ error?: string; opened?: boolean }>(
      guest,
      ref,
      openScript,
      [],
      signal,
    );
    const openResult = opened.handled
      ? opened.value
      : await evaluate<{ error?: string; opened?: boolean }>(guest, `(() => {
        const record = window.__mixdogAgentSnapshot?.refs?.get(${JSON.stringify(ref)});
        const el = record?.element || record;
        if (!el || !el.isConnected) return { error: 'stale' };
        const target = el.closest('[role="combobox"],[role="listbox"],[aria-haspopup]') || el;
        if (target.getAttribute('aria-expanded') !== 'true') {
          target.scrollIntoView({ block: 'center', behavior: 'instant' });
          target.click();
        }
        return { opened: true };
      })()`, signal);
    if (openResult?.error) {
      throw new Error(openResult.error === 'stale'
        ? `ref ${ref} is stale or unknown; take a fresh snapshot first`
        : openResult.error);
    }
    const pickScript = `(() => {
      const wanted = ${JSON.stringify(String(values[0] ?? ''))}.trim().toLowerCase();
      if (!wanted) return { error: 'empty' };
      const compact = (value) => String(value == null ? '' : value)
        .slice(0, 2_000).replace(/\\s+/g, ' ').trim();
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none';
      };
      const candidates = [];
      for (const candidate of document.querySelectorAll(
        '[role="option"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="treeitem"],[data-value]'
      )) {
        if (visible(candidate)) candidates.push(candidate);
        if (candidates.length >= 500) break;
      }
      const label = (el) => compact(el.getAttribute('aria-label') || el.textContent).toLowerCase();
      const dataValue = (el) => compact(el.getAttribute('data-value')).toLowerCase();
      const hit = candidates.find((el) => label(el) === wanted || dataValue(el) === wanted)
        || candidates.find((el) => label(el).includes(wanted));
      if (!hit) {
        const sample = candidates.slice(0, 8).map((el) => compact(el.textContent).slice(0, 40))
          .filter(Boolean);
        return {
          hasOptions: sample.length > 0,
          error: sample.length
            ? 'no open option matched; visible options include: ' + sample.join(' | ')
            : 'no open option list was found after opening the control',
        };
      }
      hit.scrollIntoView({ block: 'center', behavior: 'instant' });
      hit.click();
      return { value: compact(hit.getAttribute('aria-label') || hit.textContent).slice(0, 120) };
    })()`;
    const deadline = Date.now() + CUSTOM_DROPDOWN_TIMEOUT_MS;
    let picked: { error?: string; hasOptions?: boolean; value?: string } | undefined;
    for (;;) {
      picked = await evaluate<{ error?: string; hasOptions?: boolean; value?: string }>(
        guest,
        pickScript,
        signal,
      );
      // An option list that is present but has no match is a real failure;
      // only an absent list is worth waiting on.
      if (picked?.value || picked?.hasOptions || picked?.error === 'empty') break;
      if (Date.now() >= deadline) break;
      await pause(CUSTOM_DROPDOWN_POLL_MS, signal);
    }
    if (picked?.error) {
      throw new Error(picked.error === 'empty' ? 'select requires a non-empty value' : picked.error);
    }
    return picked?.value ? [picked.value] : [];
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

  async function selectRef(
    guest: WebContents,
    ref: string,
    values: string[],
    signal?: AbortSignal,
  ): Promise<string[]> {
    const accessibility = await callAccessibilityRef<{
      error?: string;
      custom?: boolean;
      values?: string[];
    }>(guest, ref, `function(values) {
      const el = this;
      if (!el || !el.isConnected) return { error: 'stale' };
      if ((el.tagName || '').toLowerCase() !== 'select') return { custom: true };
      const wanted = values.map(String);
      const matched = [];
      for (const option of el.options) {
        const selected = wanted.includes(String(option.value)) || wanted.includes(String(option.label || option.text));
        option.selected = selected;
        if (selected) matched.push(String(option.value));
      }
      if (!matched.length) return { error: 'no option matched the requested values' };
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { values: matched };
    }`, [values], signal);
    const result = accessibility.handled
      ? accessibility.value
      : await evaluate<{ error?: string; custom?: boolean; values?: string[] }>(guest, `(() => {
        const record = window.__mixdogAgentSnapshot?.refs?.get(${JSON.stringify(ref)});
        const el = record?.element || record;
        if (!el || !el.isConnected) return { error: 'stale' };
        if ((el.tagName || '').toLowerCase() !== 'select') return { custom: true };
        const wanted = ${JSON.stringify(values)}.map(String);
        const matched = [];
        for (const option of el.options) {
          const selected = wanted.includes(String(option.value)) || wanted.includes(String(option.label || option.text));
          option.selected = selected;
          if (selected) matched.push(String(option.value));
        }
        if (!matched.length) return { error: 'no option matched the requested values' };
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { values: matched };
      })()`, signal);
    if (result?.custom) return await selectCustomRef(guest, ref, values, signal);
    if (result?.error) {
      throw new Error(result.error === 'stale'
        ? `ref ${ref} is stale or unknown; take a fresh snapshot first`
        : result.error);
    }
    return result?.values || [];
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

  async function uploadRef(
    guest: WebContents,
    ref: string,
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
    const cdp = await guestDebugger(guest);
    const accessibilitySnapshot = accessibilityRefs(guest);
    if (accessibilitySnapshot) {
      const target = accessibilitySnapshot.refs.get(ref);
      if (!target) throw new Error(`ref ${ref} is stale or unknown; take a fresh snapshot first`);
      const resolved = await sendCdp<{ object?: { objectId?: string } }>(
        guest,
        cdp,
        'DOM.resolveNode',
        { backendNodeId: target.backendNodeId },
        CDP_REQUEST_TIMEOUT_MS,
        signal,
        target.sessionId,
      );
      const objectId = resolved.object?.objectId;
      if (!objectId) throw new Error(`ref ${ref} is stale or detached; take a fresh snapshot first`);
      try {
        const validation = await sendCdp<{
          result?: { value?: { valid?: boolean } };
          exceptionDetails?: unknown;
        }>(
          guest,
          cdp,
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration: `function() {
              return {
                valid: (this.tagName || '').toLowerCase() === 'input'
                  && String(this.type || '').toLowerCase() === 'file',
              };
            }`,
            returnByValue: true,
          },
          CDP_REQUEST_TIMEOUT_MS,
          signal,
          target.sessionId,
        );
        if (validation.exceptionDetails || validation.result?.value?.valid !== true) {
          throw new Error(`ref ${ref} is not a file input`);
        }
        await sendCdp(
          guest,
          cdp,
          'DOM.setFileInputFiles',
          { files: paths, objectId },
          CDP_REQUEST_TIMEOUT_MS,
          signal,
          target.sessionId,
        );
      } finally {
        void cdp.sendCommand('Runtime.releaseObject', { objectId }, target.sessionId).catch(() => undefined);
      }
      return;
    }
    const response = await sendCdp<{
      result?: { objectId?: string; subtype?: string; description?: string };
      exceptionDetails?: unknown;
    }>(guest, cdp, 'Runtime.evaluate', {
      expression: `(() => {
        const record = window.__mixdogAgentSnapshot?.refs?.get(${JSON.stringify(ref)});
        const el = record?.element || record;
        if (!el || !el.isConnected) throw new Error('stale ref');
        if ((el.tagName || '').toLowerCase() !== 'input' || String(el.type || '').toLowerCase() !== 'file') {
          throw new Error('element is not a file input');
        }
        return el;
      })()`,
      returnByValue: false,
      userGesture: true,
    }, CDP_REQUEST_TIMEOUT_MS, signal);
    const objectId = response.result?.objectId;
    if (!objectId || response.exceptionDetails) throw new Error(`ref ${ref} is stale or is not a file input`);
    try {
      await sendCdp(
        guest,
        cdp,
        'DOM.setFileInputFiles',
        { files: paths, objectId },
        CDP_REQUEST_TIMEOUT_MS,
        signal,
      );
    } finally {
      void cdp.sendCommand('Runtime.releaseObject', { objectId }).catch(() => undefined);
    }
  }

  return {
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
