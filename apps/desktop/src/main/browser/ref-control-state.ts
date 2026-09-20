/**
 * Native control state read from the element itself: the options a <select>
 * offers (which the accessibility tree hides until it opens), and a checkbox
 * or radio button's checked state — changed by clicking it once, then read
 * back, never toggled blindly.
 */
import type { WebContents } from 'electron';

import { checkedBrowserRefResult, type createBrowserRefAccess } from './ref-access';
import type { BrowserRefActionsHost } from './ref-actions';

export type RefControlStateHost = Pick<BrowserRefActionsHost, 'resolveRefPoint' | 'input'>;
type CallRef = ReturnType<typeof createBrowserRefAccess>['callRef'];

const READ_SELECT_OPTIONS = `function() {
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

const READ_CHECKED = `function() {
  const el = this;
  if (!el || !el.isConnected) return { error: 'stale' };
  const tag = (el.tagName || '').toLowerCase();
  const type = String(el.type || '').toLowerCase();
  if (tag !== 'input' || !['checkbox', 'radio'].includes(type)) {
    return { error: 'element is not a checkbox or radio button' };
  }
  return { checked: Boolean(el.checked), radio: type === 'radio' };
}`;

export function createRefControlState(host: RefControlStateHost, callRef: CallRef) {
  const { resolveRefPoint, input: browserInput } = host;

  /** What a control offers, without choosing anything. A native <select> keeps
   *  its options out of the accessibility tree, so they are read from the
   *  element itself; a custom dropdown puts its options in the page once it is
   *  open, where a snapshot already sees them. */
  async function listSelectOptions(guest: WebContents, ref: string, signal?: AbortSignal): Promise<string[]> {
    const result = checkedBrowserRefResult(
      await callRef<{
        error?: string;
        custom?: boolean;
        options?: string[];
      }>(guest, ref, READ_SELECT_OPTIONS, [], signal),
      ref
    );
    if (result?.custom) {
      throw new Error(
        `ref ${ref} is not a native <select>; click it to open the list, then read the options from the fresh snapshot`
      );
    }
    return result?.options || [];
  }

  async function checkedRefState(
    guest: WebContents,
    ref: string,
    signal?: AbortSignal
  ): Promise<{ checked: boolean; radio: boolean }> {
    const state = checkedBrowserRefResult(
      await callRef<{
        error?: string;
        checked?: boolean;
        radio?: boolean;
      }>(guest, ref, READ_CHECKED, [], signal),
      ref
    );
    return { checked: state?.checked === true, radio: state?.radio === true };
  }

  async function setCheckedRef(guest: WebContents, ref: string, checked: boolean, signal?: AbortSignal): Promise<void> {
    const state = await checkedRefState(guest, ref, signal);
    if (state.radio && !checked) throw new Error('radio buttons cannot be unchecked directly; choose another option');
    if (state.checked !== checked) {
      const point = await resolveRefPoint(guest, ref, signal);
      await browserInput.clickAt(guest, point.x, point.y, 1, 'left', 0, signal);
      const finalState = await checkedRefState(guest, ref, signal);
      if (finalState.checked !== checked) {
        throw new Error(
          `check input was dispatched once but the element remained checked=${finalState.checked}; the action was not retried`
        );
      }
    }
  }

  return { listSelectOptions, checkedRefState, setCheckedRef };
}
