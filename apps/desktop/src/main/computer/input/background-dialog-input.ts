/**
 * Why a dialog refuses background keystrokes. A modal dialog routes keys
 * through the dialog manager of the thread that owns the input focus, so a
 * message posted to an unfocused dialog is discarded, and the keys that press
 * a default button never reach one. Both cases used to report delivery as a
 * success while the dialog stood untouched, which is worse than a refusal:
 * the caller reads "done" and moves on.
 */
import type { ComputerWindowRecord } from '../shared/window-transition';

/** Win32 registers every standard dialog under this class. */
export const DIALOG_WINDOW_CLASS_NAME = '#32770';

/** Keys the dialog manager interprets for the whole dialog rather than for
 *  the focused control. */
const DIALOG_MANAGER_KEYS = new Set(['enter', 'return', 'escape', 'esc', 'space', 'spacebar', 'tab']);

export interface BackgroundDialogInput {
  action: string;
  delivery?: string;
  keys?: string;
  /** A ref addresses the control itself, so it does not depend on the dialog
   *  holding focus. */
  hasRef?: boolean;
  targetWindowId: string;
  windows: ComputerWindowRecord[] | null;
}

function dialogManagerKey(keys: string): string {
  const normalized = keys.trim().toLowerCase().replace(/^\{/, '').replace(/\}$/, '');
  return DIALOG_MANAGER_KEYS.has(normalized) ? normalized : '';
}

function dialogLabel(window: ComputerWindowRecord): string {
  return window.title ? `'${window.title}'` : 'the dialog';
}

export function backgroundDialogInputError(input: BackgroundDialogInput): string | null {
  if (input.delivery === 'foreground') return null;
  if (input.action !== 'key' && input.action !== 'type') return null;
  const windows = input.windows;
  if (!windows?.length || !input.targetWindowId) return null;
  const target = windows.find((window) => window.id === input.targetWindowId);
  if (!target || target.className !== DIALOG_WINDOW_CLASS_NAME) return null;

  const focused = windows.find((window) => window.focused);
  if (!input.hasRef && focused && focused.id !== target.id) {
    return (
      `focus_required: ${dialogLabel(target)} does not hold keyboard focus, so background ` +
      `${input.action} would be discarded without changing it; no input was sent. Focus that window first ` +
      '(window operation="focus"), address the control with a fresh ref, or repeat with delivery="foreground".'
    );
  }
  if (input.action === 'key') {
    const key = dialogManagerKey(String(input.keys || ''));
    if (key) {
      return (
        `dialog_key_unsupported: ${dialogLabel(target)} routes '${key}' through the dialog manager, which a ` +
        'background message bypasses, so no button would be pressed; no input was sent. Click the button by ref ' +
        'or element, or repeat with delivery="foreground".'
      );
    }
  }
  return null;
}
