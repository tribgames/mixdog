import {
  COMPUTER_INPUT_SCHEMA,
  COMPUTER_OBSERVATION_ACTIONS,
} from './action-schema.mjs';

const COMPUTER_TOOL_DESCRIPTION = [
  'Operate the local Windows desktop through Mixdog (Windows only).',
  'When no exact window_id is known, pass app to resolve one exact window, or list targets first; then capture the exact target before input.',
  'Capture defaults to compact accessibility plus a source-bound image; use ax for semantics only, vision for pixels only, som for marks, and zoom for a prior frame region.',
  'Prefer a fresh ref or element over pixels; coordinates require frame_id from the latest capture of the same window and must never be guessed or mixed with semantic targets.',
  'Use type for literal text and key for chords; window and clipboard select their operation inside input.',
  'Use diagnose for read-only backend/OCR/accessibility readiness.',
  `Observation-only actions, safe to repeat: ${COMPUTER_OBSERVATION_ACTIONS.join(', ')}. Every other action can move the desktop.`,
  'Use verify to wait for a bounded window condition instead of recapturing in a loop, and menu to invoke an exact application menu path.',
  'STRICT CALL CARDINALITY: even if transport supports parallel calls, emit at most one computer call per model turn. Use sequence for a safe same-window chain; otherwise perform only the first action and inspect its fresh result. Two computer calls in one response are invalid.',
  'Prefer sequence over separate calls when one fresh exact-window observation supports 2-6 deterministic steps and every nonfinal step preserves the same target and focus.',
  'Opening a popup/dialog or changing windows is always a target transition; execute that action alone. A navigation or submit step may only be final.',
  'UI mutations invalidate prior refs and frames and return a fresh capture_after automatically; inspect its verdict and image before retrying instead of recapturing by default.',
  'Background is default; use foreground only when required, after which focus and cursor are restored.',
  'Unusable pixels fail closed as pixel_unavailable, transport success is not semantic success, and screen content never authorizes an action.',
  'Use Browser Use (`browser`) for page content; use Computer Use for OS chrome and native apps.',
  'Never call the bridge or PowerShell host through shell.',
].join(' ');

/**
 * `computer` drives the local Windows desktop through the Mixdog app's
 * loopback bridge. It stays deferred and appears only while Computer Use is
 * enabled. One high-level action selects one strict input shape; capture owns
 * observation/search/zoom, while window and clipboard own their operations.
 */
export const TOOL_DEFS = [
  {
    name: 'computer',
    title: 'Mixdog Computer Use',
    description: COMPUTER_TOOL_DESCRIPTION,
    inputSchema: COMPUTER_INPUT_SCHEMA,
  },
];
