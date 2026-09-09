/** Bound unstarted human input without interrupting an already-dispatched edit. */
export const BROWSER_INPUT_WAIT_MS = 2_000;
export const BROWSER_INPUT_EXPIRED = 'Browser input expired; input was not sent.';
export const BROWSER_INPUT_BUSY = 'Browser input is busy; input was not sent.';

/** Session-owned tab controls can escape a blocked page without editing it. */
export function browserTabControl(action: { type: string }): boolean {
  return action.type === 'new-tab' || action.type === 'select-tab' || action.type === 'close-tab';
}

/** Only explicit recovery controls may bypass a blocked page's input fences. */
export function browserInputRecovery(action: { type: string }): boolean {
  return action.type === 'stop' || action.type === 'reload' || browserTabControl(action);
}

/** Pane geometry is native presentation state, not an edit to the document. */
export function browserInputImmediate(action: { type: string }): boolean {
  return browserInputRecovery(action) || action.type === 'resize'
    || action.type === 'answer-dialog' || action.type === 'choose-files';
}
