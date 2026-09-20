/**
 * Putting text into one element by ref. `fill` replaces the whole value the
 * way a form library expects — through the native value setter, with the
 * input and change events a page listens for — while `type` sends real
 * keystrokes for controls that only react while a person types. A rich
 * editor owns its DOM, so its text is replaced as typed input instead.
 */
import type { WebContents } from 'electron';

import { BROWSER_EDITABILITY_CHECK } from './editability';
import { checkedBrowserRefResult, type createBrowserRefAccess } from './ref-access';
import type { BrowserRefActionsHost } from './ref-actions';
import { redactBrowserText } from './redaction';

export type RefTextEntryHost = Pick<BrowserRefActionsHost, 'cdp' | 'input' | 'rememberSecret'>;
type CallRef = ReturnType<typeof createBrowserRefAccess>['callRef'];

/** Page functions written once for both realms: the accessibility snapshot
 *  applies them to the ref's element, and a page without that snapshot applies
 *  the same source to the element its ref table still holds. */
const FILL_REF = `function(text) {
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
    const doc = el.ownerDocument;
    const range = doc.createRange();
    range.selectNodeContents(el);
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return { contentEditable: true };
  }
  return { error: 'element is not editable' };
}`;

const FOCUS_REF = `function() {
  const el = this;
  if (!el || !el.isConnected) return { error: 'stale' };
  const editError = (${BROWSER_EDITABILITY_CHECK})(el);
  if (editError) return { error: editError };
  if (!(el.matches?.('input, textarea') || el.isContentEditable)) return { error: 'element is not editable' };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.focus();
  return { sensitive: el.type === 'password' };
}`;

export function createRefTextEntry(host: RefTextEntryHost, callRef: CallRef) {
  const { cdp, input: browserInput } = host;

  /** A rich editor owns its DOM: writing textContent bypasses its model and
   *  the next render drops the text. Select everything and insert the new
   *  text as typed input instead, the way a person replaces it. */
  async function replaceContentEditable(
    guest: WebContents,
    ref: string,
    text: string,
    signal?: AbortSignal
  ): Promise<string> {
    if (text) {
      await cdp.sendCdpInput(guest, await cdp.guestDebugger(guest), 'Input.insertText', { text }, signal);
    } else {
      await browserInput.pressKey(guest, 'Backspace', signal);
    }
    const actual = await callRef<string>(
      guest,
      ref,
      'function() { return String(this.innerText ?? this.textContent ?? ""); }',
      [],
      signal
    );
    const compact = (value: string) =>
      String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
    if (compact(text) && !compact(actual)) {
      throw new Error('the editor did not keep the inserted text; click into it first or use type');
    }
    return redactBrowserText(actual);
  }

  async function fillRef(guest: WebContents, ref: string, text: string, signal?: AbortSignal): Promise<string> {
    const outcome = checkedBrowserRefResult(
      await callRef<{
        error?: string;
        value?: string;
        sensitive?: boolean;
        contentEditable?: boolean;
      }>(guest, ref, FILL_REF, [text], signal),
      ref
    );
    if (outcome?.contentEditable) return replaceContentEditable(guest, ref, text, signal);
    if (outcome?.sensitive && text) host.rememberSecret?.(guest, text);
    return outcome?.sensitive ? '[REDACTED]' : redactBrowserText(outcome?.value ?? '');
  }

  async function typeRef(guest: WebContents, ref: string, text: string, signal?: AbortSignal): Promise<void> {
    const focused = checkedBrowserRefResult(
      await callRef<{ error?: string; sensitive?: boolean }>(guest, ref, FOCUS_REF, [], signal),
      ref
    );
    if (focused?.sensitive && text) host.rememberSecret?.(guest, text);
    await browserInput.pressKey(guest, process.platform === 'darwin' ? 'Meta+A' : 'Control+A', signal);
    await browserInput.pressKey(guest, 'Backspace', signal);
    // Real keystrokes, not an insertion: this is the gesture for controls that
    // only react while a person types. `fill` owns bulk replacement.
    await browserInput.typeText(guest, text, signal);
  }

  return { fillRef, typeRef };
}
