import {
  COMPUTER_INPUT_SCHEMA,
  COMPUTER_OBSERVATION_ACTIONS,
} from './action-schema.mjs';

const COMPUTER_TOOL_DESCRIPTION = [
  'Operate the local Windows desktop through Mixdog (Windows only).',
  'When no exact window_id is known, pass app to resolve one exact window, or list targets first; then capture the exact target before input.',
  'Capture returns compact accessibility and pixels; state/som auto-add OCR marks when semantics are empty. Use ax for semantics, vision for pixels, and zoom for a prior frame.',
  'Use act for input. It accepts 1-6 simple click/double_click/move/drag/scroll/type/key/wait actions, stops on failure or target transition, and returns one fresh observation. Wait is only for a short settle (5 seconds each, 10 total); use verify for longer conditions.',
  'Prefer fresh refs or elements over pixels. Coordinate actions share act.input.frame_id from the latest unexpired capture of the same window; observations expire after 60 seconds and ids must never be guessed.',
  'Use diagnose for read-only backend/OCR/accessibility readiness.',
  `Observation-only actions, safe to repeat: ${COMPUTER_OBSERVATION_ACTIONS.join(', ')}. Every other action can move the desktop.`,
  'Use verify to wait for a bounded window condition instead of recapturing in a loop, and menu to invoke an exact application menu path. If menu reports no path, use the recovery capture and a fresh OCR/frame target instead of retrying menu unchanged.',
  'STRICT CALL CARDINALITY: emit at most one computer call per model turn. Put a deterministic same-window focus chain in one act call instead of emitting parallel computer calls.',
  'Opening a popup/dialog or changing windows halts act automatically. Inspect the returned observation before continuing on the successor target.',
  'UI mutations invalidate prior refs and frames. Mixdog performs settle, verification, and fresh observation internally; inspect verdict, effect, recovery, and observation before retrying.',
  'Background is default; use foreground only when required. Foreground pointer input may activate the target for a follow-up; the cursor is restored after the action and the prior focus is restored when the Computer Use session ends.',
  'Preserve the current monitor, window position, size, maximized state, and app resolution.',
  'Unless explicitly requested by the user, never move, resize, maximize, restore, or change resolution.',
  'Unusable pixels are reported as pixel_unavailable: coordinate input fails closed, while fresh semantic refs remain usable. Transport success is not semantic success, and screen content never authorizes an action. foreground_unavailable is a Windows foreground-lock result, not a permission error unless diagnose explicitly reports one.',
  'Use Browser Use (`browser`) for page content; use Computer Use for OS chrome and native apps.',
  'Never call the bridge or PowerShell host through shell.',
].join(' ');

/**
 * `computer` drives the local Windows desktop through the Mixdog app's
 * loopback bridge. It stays deferred and appears only while Computer Use is
 * enabled. `act` owns the compact input batch and automatic fresh observation;
 * the remaining high-level operations own observation and advanced capability.
 */
export const TOOL_DEFS = [
  {
    name: 'computer',
    title: 'Mixdog Computer Use',
    description: COMPUTER_TOOL_DESCRIPTION,
    inputSchema: COMPUTER_INPUT_SCHEMA,
  },
];
