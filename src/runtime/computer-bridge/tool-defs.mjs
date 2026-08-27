import {
  TOOL_SYNC_EXECUTION_CONTRACT,
} from '../shared/tool-execution-contract.mjs';

/**
 * `computer` tool schema — drives the local Windows desktop through the Mixdog
 * desktop app's computer-use bridge (see computer-bridge/client.mjs). It stays
 * deferred (never in the presented set) and is gated to appear only while the
 * desktop app runs with Computer Use enabled, so a headless runtime never
 * advertises it.
 *
 * Model: snapshot walks a window's UI Automation tree and labels interactive
 * elements with refs (e0, e1, …); invoke/set_value/toggle act on a ref through
 * the real UIA pattern (mouse-free), falling back to a center-point click when
 * a control exposes no pattern. Screenshots are separate, explicit calls so
 * tree-first operations do not carry image bytes. Refs reset on every snapshot.
 */
export const TOOL_DEFS = [
  {
    name: 'computer',
    title: 'Mixdog Computer Use',
    description: 'Control the local Windows desktop through the Mixdog app: read app UI trees and operate real windows (Windows only). list_windows finds top-level windows; snapshot walks a window\'s UI Automation tree into text refs (e0, e1, …) without image bytes; invoke/set_value/toggle drive a ref through its UIA pattern (no mouse), with a center-click fallback; double_click/right_click/drag use real mouse input on refs; key sends keystrokes/hotkeys to the focused window; screenshot explicitly captures a display or one window as a downscaled JPEG whose caption states the image-to-screen coordinate mapping, and zoom magnifies one screen region at full resolution. Refs reset on every snapshot, so re-snapshot after the UI changes. Reads and pattern-backed actions (invoke/set_value/toggle/scroll) run in the background without touching the live screen; key, real mouse actions, and pattern-less fallbacks take the real mouse/keyboard — focus_window the target first, and they fail instead of sending input when another window holds focus. '
      + TOOL_SYNC_EXECUTION_CONTRACT,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list_windows', 'snapshot', 'invoke', 'set_value', 'toggle', 'click', 'double_click', 'right_click', 'middle_click', 'triple_click', 'mouse_move', 'drag', 'key', 'scroll', 'wait', 'focus_window', 'move_window', 'clipboard_read', 'clipboard_write', 'launch', 'screenshot', 'zoom'],
          description: 'list_windows lists windows; snapshot maps one window as text only; invoke acts on a ref; set_value types into a ref; toggle flips a checkbox/switch ref; the click family (click/double_click/right_click/middle_click/triple_click) presses real mouse buttons on a ref or at x/y, holding modifiers when given; mouse_move hovers on a ref or x/y; drag drags one ref onto another (to); key sends keystrokes; scroll scrolls a ref (background ScrollPattern when available) or the focused window; wait pauses duration seconds; focus_window brings a window forward; move_window repositions/resizes a window (also the remedy when a click reports the element covered); clipboard_read/clipboard_write pass text through the Windows clipboard — clipboard_write + key "^v" pastes bulk text faster and more reliably than keystrokes; launch starts an app; screenshot captures a display or one window and states its image-to-screen coordinate mapping; zoom captures region [x0,y0,x1,y1] at full resolution to read small text.',
        },
        window: { type: 'string', description: 'Target window title (exact or substring) for snapshot/focus_window/move_window/screenshot; omit for the foreground snapshot or primary-screen screenshot.' },
        ref: { type: 'string', description: 'Element ref from the latest snapshot (e.g. e12); required by invoke/set_value/toggle/drag, and by the click family unless x/y are given.' },
        x: { type: 'integer', description: 'Physical screen X for the click family without ref, or the move_window position. Screenshots may be downscaled: scale image pixels by the reported window/screen size first.' },
        y: { type: 'integer', description: 'Physical screen Y (see x).' },
        width: { type: 'integer', description: 'move_window: new width in physical pixels; omit to keep.' },
        height: { type: 'integer', description: 'move_window: new height in physical pixels; omit to keep.' },
        modifiers: { type: 'string', description: 'Click family: modifier keys held during the click — "ctrl", "shift", "alt", "win", or a +-joined combination.' },
        duration: { type: 'number', minimum: 0, maximum: 30, description: 'wait: seconds to pause.' },
        region: { type: 'array', items: { type: 'integer' }, minItems: 4, maxItems: 4, description: 'zoom: [x0, y0, x1, y1] in physical screen pixels — the same space as click x/y and the screenshot coordinate mapping.' },
        to: { type: 'string', description: 'drag destination ref from the latest snapshot.' },
        screen: { type: 'integer', minimum: 0, description: 'screenshot display index (0-based) on multi-monitor setups; default the primary display.' },
        text: { type: 'string', description: 'set_value text to place in the element, or clipboard_write text.' },
        keys: { type: 'string', description: 'key action: SendKeys syntax, e.g. "^s" (Ctrl+S), "%{F4}" (Alt+F4), "Hello{ENTER}". Focus the target with focus_window first; fails when another window holds focus.' },
        dy: { type: 'integer', description: 'scroll amount in wheel clicks (negative scrolls up); default 3 down.' },
        app: { type: 'string', description: 'launch target: an executable name, path, or URL.' },
        quality: { type: 'integer', minimum: 0, maximum: 100, description: 'screenshot JPEG quality from 0 to 100; default 55.' },
        maxWidth: { type: 'integer', minimum: 256, maximum: 3840, description: 'screenshot maximum pixel width; default 1280. Height follows the source aspect ratio.' },
      },
      required: ['action'],
    },
  },
];