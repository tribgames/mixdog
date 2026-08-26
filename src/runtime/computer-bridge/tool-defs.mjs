import {
  TOOL_SYNC_EXECUTION_CONTRACT,
} from '../shared/tool-execution-contract.mjs';

/**
 * `computer` tool schema — drives the local Windows desktop through the Mixdog
 * desktop app's computer-use bridge (see computer-bridge/client.mjs). It stays
 * deferred (never in the presented set) and is gated to appear only while the
 * desktop app runs with computer control enabled, so a headless runtime never
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
    description: 'Control the local Windows desktop through the Mixdog app: read app UI trees and operate real windows (Windows only). list_windows finds top-level windows; snapshot walks a window\'s UI Automation tree into text refs (e0, e1, …) without image bytes; invoke/set_value/toggle drive a ref through its UIA pattern (no mouse), with a center-click fallback; key sends keystrokes/hotkeys to the focused window; screenshot explicitly captures the primary screen or one window as a downscaled JPEG. Refs reset on every snapshot, so re-snapshot after the UI changes. '
      + TOOL_SYNC_EXECUTION_CONTRACT,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list_windows', 'snapshot', 'invoke', 'set_value', 'toggle', 'key', 'scroll', 'focus_window', 'launch', 'screenshot'],
          description: 'list_windows lists windows; snapshot maps one window as text only; invoke acts on a ref; set_value types into a ref; toggle flips a checkbox/switch ref; key sends keystrokes; scroll scrolls a ref or the focused window; focus_window brings a window forward; launch starts an app; screenshot captures the primary screen or one window.',
        },
        window: { type: 'string', description: 'Target window title (exact or substring) for snapshot/focus_window/screenshot; omit for the foreground snapshot or primary-screen screenshot.' },
        ref: { type: 'string', description: 'Element ref from the latest snapshot (e.g. e12); required by invoke/set_value/toggle.' },
        text: { type: 'string', description: 'set_value text to place in the element.' },
        keys: { type: 'string', description: 'key action: SendKeys syntax, e.g. "^s" (Ctrl+S), "%{F4}" (Alt+F4), "Hello{ENTER}".' },
        dy: { type: 'integer', description: 'scroll amount in wheel clicks (negative scrolls up); default 3 down.' },
        app: { type: 'string', description: 'launch target: an executable name, path, or URL.' },
        quality: { type: 'integer', minimum: 0, maximum: 100, description: 'screenshot JPEG quality from 0 to 100; default 55.' },
        maxWidth: { type: 'integer', minimum: 256, maximum: 3840, description: 'screenshot maximum pixel width; default 1280. Height follows the source aspect ratio.' },
      },
      required: ['action'],
    },
  },
];