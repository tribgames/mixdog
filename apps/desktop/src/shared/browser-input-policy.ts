/** Bound unstarted human input without interrupting an already-dispatched edit. */
export const BROWSER_INPUT_WAIT_MS = 2_000;
export const BROWSER_INPUT_EXPIRED = 'Browser input expired; input was not sent.';
export const BROWSER_INPUT_BUSY = 'Browser input is busy; input was not sent.';

/** Typing is ordered text editing, not expendable pointer motion. */
export function browserTypingInput(action: { type: string }): boolean {
  return (
    action.type === 'text' ||
    action.type === 'key' ||
    action.type === 'composition' ||
    action.type === 'composition-end'
  );
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
