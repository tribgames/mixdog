#!/usr/bin/env node
// Recording of computer-bridge/error-recovery.test.mjs (b6f10295a): what a failed computer action tells the model to do next.
// `computerToolErrorRecovery(message, args)` and `formatComputerToolError(message, args)` over every failure category the module
// knows (both code separators, a leading `Error:`, the two sentences the host words without a code, a code it does not know) and
// over the targets a call can name (a window, an app, neither) and the actions whose timeout differs (a read and an input).
//
//   node benchmarks/rust-core/recorders/record-computer-error-recovery.mjs --tree <export of b6f10295a with node_modules>
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'computer-error-recovery-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[key] = join(sandbox, key.toLowerCase());
  mkdirSync(process.env[key], { recursive: true });
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
const { openSet } = await import('./lib/case-set.mjs');

const set = openSet('computer-error-recovery', import.meta.url);
const { computerToolErrorRecovery, formatComputerToolError } = await set.load('src/runtime/computer-bridge/error-recovery.mjs');

const CODES = [
  'computer_background_cleanup_unconfirmed', 'ambiguous_window_target', 'window_stale', 'window_target_not_found', 'stale_frame', 'stale_target',
  'target_mismatch', 'computer_target_available_recapture_required', 'computer_foreground_available_recapture_required', 'computer_target_in_use',
  'computer_user_control_active', 'computer_user_takeover', 'user_input_active', 'input_recovery_unconfirmed', 'input_observation_unavailable',
  'computer_cursor_unavailable', 'computer_cleanup_pending', 'computer_abort_cleanup_unconfirmed', 'input_cleanup_unconfirmed',
  'privileged_worker_cleanup_unconfirmed', 'foreground_input_not_ready', 'saved_login_refused', 'saved_login_changed', 'saved_login_unavailable',
  'saved_login_unconfirmed', 'computer_command_timeout', 'menu_path_not_found', 'menu_item_disabled', 'foreground_changed', 'foreground_unavailable',
  'background_unsupported', 'background_input_failed', 'pixel_unavailable', 'observation_unavailable', 'capture_withheld', 'Unknown_Code',
];
const TARGETS = [
  ['a window', { action: 'act', input: { window_id: 'hwnd:0x1' } }],
  ['an app', { action: 'act', input: { app: 'Notepad' } }],
  ['no target', { action: 'act' }],
  ['a read of a window', { action: 'capture', input: { window_id: 'hwnd:0x2' } }],
];
const both = (message, args) => ({ recovery: computerToolErrorRecovery(message, args) ?? null, text: formatComputerToolError(message, args) });

for (const code of CODES) {
  await set.run(`${code}`, () => TARGETS.map(([label, args]) => ({ label, args, ...both(`${code}: private window details`, args) })), { input: { code } });
}
await set.run('separators, prefixes and codeless sentences', () =>
  [
    'Error: target_mismatch|private window details', 'Error:   target_mismatch: x', 'error: target_mismatch: x', 'ERROR: Window_Stale: gone',
    'window_id is stale', 'the window is stale now', 'take a fresh capture first, then act', 'unknown frame_id frame-1', 'fresh capture\nfirst',
    'unstructured private text', `${'a'.repeat(81)}: private`, `${'a'.repeat(80)}: private`, '1abc: x', 'abc def: x', '', '   ', ': nothing',
  ].map((message) => ({ message, ...both(message, { action: 'act', input: { window_id: 'hwnd:0x1' } }) })), { input: {} });
await set.run('a missing message', () => ({ empty: formatComputerToolError('', {}), none: formatComputerToolError(undefined, {}), nullish: formatComputerToolError(null) }), { input: {} });

await set.finish({
  entry: 'computer-bridge/error-recovery.mjs computerToolErrorRecovery and formatComputerToolError (the text a failed computer call returns the model, client.mjs formatComputerToolError)',
  replay: { entry: 'computer_recovery::tool_error_recovery and format_tool_error over the recorded messages and targets; compared whole', normalised: {} },
  exclusions: { computerResultRecovery: 'a reply body with a structured code (yielded, delivery_accepted) has no counterpart: the Rust backend answers its replies as text parts and raises failures as errors' },
});
process.exit(0);
