// Which Linux capability each host command really needs, read from
// native/mixdog-computer (host/*.rs) and the desktop app's observation layer.
// Only a hard requirement is listed: an action that merely works better with a
// capability (OCR for capture, AT-SPI for a state capture, which degrades to
// pixels) does not name it, so a missing optional piece never blocks it.
//
//   windows         a window list/handle (X11 EWMH, sway, Hyprland, GNOME Window
//                   Calls). Every native window target (window_id, app, the
//                   foreground window) resolves through it.
//   accessibility   the AT-SPI bus.
//   semanticActions AT-SPI actions (invoke, toggle, set_value, menu): they act
//                   on an accessible found through a window handle, so they need
//                   both and use no input device.
//   pointer/keyboard the input device (uinput on Wayland, XTest on X11).

const WINDOW_ACTIONS = new Set([
  'list_windows', 'window_snapshot', 'related_windows', 'window_bounds', 'window_capture',
  'window_integrity', 'validate_background_input', 'list_apps', 'verify', 'focus_window',
  'move_window', 'window_state', 'close_window', 'terminate_process',
]);
const ACCESSIBILITY_ACTIONS = new Set(['snapshot', 'find', 'window_predicates', 'accessibility_probe']);
const SEMANTIC_ACTIONS = new Set(['invoke', 'set_value', 'toggle', 'invoke_menu']);
const POINTER_ACTIONS = new Set([
  'click', 'double_click', 'right_click', 'middle_click', 'triple_click',
  'mouse_down', 'mouse_up', 'mouse_move', 'drag', 'scroll',
]);
const KEYBOARD_ACTIONS = new Set(['type', 'key', 'key_down', 'key_up']);

const namesWindow = (command) => Boolean(command?.window_id || command?.app || command?.window);

function addStepNeeds(need, step, delivery) {
  const action = String(step?.action || '');
  const foreground = delivery === 'foreground';
  if (step?.ref || step?.element) need.add('accessibility');
  if (SEMANTIC_ACTIONS.has(action)) {
    // A foreground invoke is a real click; every other semantic action is AT-SPI.
    if (action === 'invoke' && foreground) need.add('pointer');
    else need.add('semanticActions');
    if (action === 'invoke_menu') need.add('windows');
  } else if (POINTER_ACTIONS.has(action)) {
    need.add('pointer');
  } else if (KEYBOARD_ACTIONS.has(action)) {
    // Background typing into a settable element goes through its value.
    if (action === 'type' && step.ref && !foreground) need.add('semanticActions');
    else need.add('keyboard');
  }
}

/** A capture that names no window or screen: it resolves the foreground window. */
export function isForegroundWindowCapture(command) {
  return String(command?.action) === 'capture' && !namesWindow(command) && command.screen === undefined;
}

/** The capabilities a host command (as toComputerHostCommand emits it) requires. */
export function requiredCapabilities(command) {
  const need = new Set();
  const action = String(command?.action || '');
  if (WINDOW_ACTIONS.has(action)) need.add('windows');
  else if (ACCESSIBILITY_ACTIONS.has(action)) {
    need.add('windows');
    need.add('accessibility');
  } else if (action === 'capture') {
    need.add('capture');
    const mode = String(command.mode || 'state');
    // Only a screen-index vision capture needs no window: every other mode
    // resolves a named window or the foreground one.
    const screenOnly = mode === 'vision' && command.screen !== undefined && !namesWindow(command);
    if (!screenOnly) need.add('windows');
    if (mode === 'ax') need.add('accessibility');
  } else if (action === 'screenshot' || action === 'zoom') {
    need.add('capture');
  } else if (action === 'clipboard_read' || action === 'clipboard_write') {
    need.add('clipboard');
  } else if (action === 'sequence') {
    // An act always names its window (the schema requires it).
    need.add('windows');
    const delivery = String(command.delivery || 'background');
    for (const step of Array.isArray(command.steps) ? command.steps : []) addStepNeeds(need, step, delivery);
  } else {
    addStepNeeds(need, command, String(command?.delivery || 'background'));
    if (need.size > 0 && namesWindow(command)) need.add('windows');
  }
  return need;
}
