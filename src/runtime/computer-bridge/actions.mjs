/**
 * One action catalogue, with explicit capabilities for each execution boundary.
 * Native reads and public replay-safe reads deliberately have different scopes.
 */
const catalogue = {};
function action(name, capabilities) {
  catalogue[name] = Object.freeze({
    policy: name,
    ...capabilities,
  });
}
const nativeRead = { nativeRead: true, retainNativeRefs: true, observeOnly: true };
const hostRead = { hostRead: true, observeOnly: true };
const replay = { replaySafe: true };
action('list_windows', { ...nativeRead, ...hostRead, ...replay, policy: 'list' });
action('window_snapshot', nativeRead);
action('related_windows', nativeRead);
action('snapshot', { ...nativeRead, ...hostRead, policy: 'capture' });
action('find', { ...nativeRead, ...hostRead, policy: 'capture' });
action('clipboard_read', { ...nativeRead, ...hostRead, ...replay, foreground: true });
action('wait', { ...nativeRead, ...hostRead, ...replay, policy: 'act' });
action('window_bounds', { ...nativeRead, ...hostRead, policy: 'capture' });
action('window_capture', nativeRead);
action('window_predicates', { ...nativeRead, ...hostRead });
action('window_integrity', nativeRead);
action('input_recovery_state', nativeRead);
action('input_idle_state', nativeRead);
action('ocr_image', nativeRead);
action('ocr_status', nativeRead);
action('release_session', { retainNativeRefs: true });
action('list_apps', { ...hostRead, ...replay, policy: 'list' });
action('capture', { ...hostRead, ...replay });
action('screenshot', { ...hostRead, policy: 'capture' });
action('zoom', { ...hostRead, ...replay, policy: 'capture' });
action('verify', { ...hostRead, ...replay });
action('diagnose', { observeOnly: true, ...replay });
action('wait_for_user', { ...hostRead, ...replay });
for (const name of ['invoke', 'set_value', 'toggle', 'click', 'double_click', 'right_click',
  'middle_click', 'triple_click', 'mouse_move', 'drag', 'type', 'key', 'scroll']) {
  action(name, {
    observationBound: true,
    autoCapture: true,
    focusContinuation: ['click', 'double_click', 'right_click', 'middle_click', 'triple_click', 'drag', 'scroll'].includes(name),
    policy: 'act',
  });
}
for (const name of ['focus_window', 'move_window', 'window_state', 'close_window', 'launch', 'invoke_menu']) {
  action(name, {
    autoCapture: true,
    foreground: true,
    policy: name === 'launch' ? 'launch' : name === 'invoke_menu' ? 'menu' : 'window',
  });
}
action('clipboard_write', { foreground: true });
action('sequence', { policy: 'act' });
for (const name of ['execution_end', 'session_release', 'session_abort']) {
  action(name, { lifecycle: true, observeOnly: true });
}
export const COMPUTER_ACTIONS = Object.freeze(catalogue);
export const COMPUTER_POLICY_ACTIONS = Object.freeze([
  'list', 'capture', 'diagnose', 'act', 'window', 'menu', 'verify', 'launch',
  'clipboard_read', 'clipboard_write',
]);
export function computerActionsWith(capability) {
  return Object.keys(COMPUTER_ACTIONS).filter((name) => COMPUTER_ACTIONS[name][capability] === true);
}
export function computerActionPolicy(name) {
  return COMPUTER_ACTIONS[name]?.policy || name;
}
export function computerActionHas(name, capability) {
  return COMPUTER_ACTIONS[name]?.[capability] === true;
}
export function computerPowerShellActionArray(capability) {
  return `@(${computerActionsWith(capability).map((name) => `'${name}'`).join(',')})`;
}
