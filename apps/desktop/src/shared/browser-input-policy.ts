/** Bound unstarted human input without interrupting an already-dispatched edit. */
export const BROWSER_INPUT_WAIT_MS = 2_000;
export const BROWSER_INPUT_EXPIRED = 'Browser input expired; input was not sent.';
export const BROWSER_INPUT_BUSY = 'Browser input is busy; input was not sent.';
export const BROWSER_DIALOG_BLOCKING = 'Browser dialog is blocking input.';

const SILENT_INPUT_REJECTION =
  /\b(?:stale|changed)\b|(?:Browser|Remote Browser Use) input (?:is busy|expired)|Browser dialog is blocking input|Browser page is not ready/i;
export function browserInputNotice(message: string): string {
  return SILENT_INPUT_REJECTION.test(message) ? '' : message;
}

/** Typing is ordered text editing, not expendable pointer motion. */
export function browserTypingInput(action: { type: string }): boolean {
  return (
    action.type === 'text' ||
    action.type === 'key' ||
    action.type === 'composition' ||
    action.type === 'composition-end'
  );
}

/** Whether a key press (a name like "a", "Backspace", "Control+v") changes text:
 *  a printable character, Backspace, Delete, Enter, or a paste, cut, undo,
 *  redo or word-delete chord. Navigation keys, Escape, Tab and modifiers alone
 *  edit nothing. */
export function browserEditingKey(spec: string): boolean {
  const plus = spec.endsWith('+');
  const parts = (plus ? spec.slice(0, -1) : spec).split('+');
  const key = plus ? '+' : (parts.pop() ?? '');
  if (plus && parts.at(-1) === '') parts.pop();
  const modifiers = new Set(parts.map((part) => part.toLowerCase()));
  const command = ['control', 'ctrl', 'meta', 'command', 'cmd'].some((name) => modifiers.has(name));
  const lower = key.toLowerCase();
  if (command) return ['v', 'x', 'z', 'y', 'backspace', 'delete'].includes(lower);
  if (['backspace', 'delete', 'enter'].includes(lower)) return true;
  return [...key].length === 1;
}

/** Whether a page-control input edits text: typed text, a committed IME
 *  composition, or an editing key. */
export function browserEditingInput(action: { type: string; key?: string; text?: string }): boolean {
  if (action.type === 'text' || action.type === 'composition-end') return Boolean(action.text);
  return action.type === 'key' && browserEditingKey(action.key ?? '');
}

/** CDP modifier bits of Control and Meta (Command). */
const CDP_COMMAND_MODIFIERS = 2 | 4;

/** Whether one CDP input event edits text, by the rule of `browserEditingKey`:
 *  inserted text, or a key press (its down event) that edits. */
export function browserEditingCdpInput(method: string, params: Record<string, unknown>): boolean {
  if (method === 'Input.insertText') return Boolean(params.text);
  if (method !== 'Input.dispatchKeyEvent' || (params.type !== 'rawKeyDown' && params.type !== 'keyDown')) return false;
  const command = (Number(params.modifiers) & CDP_COMMAND_MODIFIERS) !== 0;
  return browserEditingKey(`${command ? 'Control+' : ''}${String(params.key ?? '')}`);
}

/** Session-owned tab controls can escape a blocked page without editing it. */
export function browserTabControl(action: { type: string }): boolean {
  return action.type === 'new-tab' || action.type === 'select-tab' || action.type === 'close-tab';
}

/** Only explicit recovery controls may bypass a blocked page's input fences. */
export function browserInputRecovery(action: { type: string }): boolean {
  return action.type === 'stop' || action.type === 'reload' || browserTabControl(action);
}

/** Pane geometry and zoom are native presentation state, not edits to the
 *  document. The pane re-applies them on every attach and navigation, so they
 *  must never queue behind agent work or expire as stale human input. */
export function browserInputPresentation(action: { type: string }): boolean {
  return action.type === 'resize' || action.type === 'zoom';
}

export function browserInputImmediate(action: { type: string }): boolean {
  return (
    browserInputRecovery(action) ||
    browserInputPresentation(action) ||
    action.type === 'answer-dialog' ||
    action.type === 'choose-files'
  );
}
