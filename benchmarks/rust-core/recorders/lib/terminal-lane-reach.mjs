// The script the terminal lane reach recording (record-terminal-lane-reach.mjs) and its replay against mixdogd (terminal-lane-reach-replay.mjs)
// share: the paired devices, the tabs, what is typed (each tab runs the framed scripted shell, lib/scripted-pty.mjs and mixdog-spawn
// scripted.rs `framed_profile`: each line it reads is written back as one chunk, `@chunks` writes the chunks given), and the one
// normalised value.

/** The three phones' credentials (each a paired device of its own). */
export const LANE_REACH_CREDENTIALS = { p1: 'aaaaaaa1', p2: 'aaaaaaa2', p3: 'aaaaaaa3' };
/** The tab the desktop opens, the tab the second phone opens (and disposes while it runs), the tab whose shell ends by itself, the tab
 *  that runs a command between shell-integration markers, and the tab whose first line spans two chunks. */
export const LANE_REACH_TABS = { desktop: 'term_lane_desk', phone: 'term_lane_ph', ends: 'term_lane_end', command: 'term_lane_cmd', split: 'term_lane_split' };
/** A line typed into a tab, and what the scripted shell writes back for it. */
export const typed = (text) => `${text}\n`;
export const echoed = (text) => `${text}\r\n`;
/** A line that has the scripted shell write `parts` as chunks of their own, in order: in a part, `\n` is written `\r\n`, `\e` ESC, `\a`
 *  BEL (each a backslash and a letter here). */
export const chunks = (...parts) => `@chunks ${parts.join('|')}\n`;
/** The shell-integration markers Node's terminal manager reads (terminal-activity.ts `TERMINAL_MARKER_PREFIX`): a command's start and
 *  its end with exit code 0, in the `chunks` escapes. */
export const MARK_START = '\\e]697;C\\a';
export const MARK_DONE = '\\e]697;D;0\\a';
/** The terminal lane's pushes as a Node phone gets them (remote-relay-push-lanes.ts:85, :132-150), recorded per phone in one order. */
export const LANE_EVENTS = ['termData', 'termActivity', 'termSizeOwner'];
/** The pushes of `kind` on `tab` a phone got. */
export const pushesOf = (pushes, kind, tab) => pushes.filter((push) => push.event === kind && push.payload?.id === tab);

/** The exit line of a tab whose scripted shell a dispose ended: its code is how each side's stand-in ends the program (Node's: libuv's
 *  TerminateProcess, 1; the core's pipe-run tab: its job, 137), not the product's (a real console gives both the shell's own
 *  STATUS_CONTROL_C_EXIT: apps/mobile/fixtures/phone-terminal). Normalised in that tab's output only, on both sides. */
const KILLED_EXIT = /\[process exited with code -?\d+\]/g;
export const KILLED_EXIT_NORMALISED = '[process exited with code <ended by the dispose>]';
export function normaliseKilledExit(phones, tab) {
  for (const got of Object.values(phones)) {
    for (const entry of pushesOf(got.pushes, 'termData', tab)) entry.payload = { ...entry.payload, data: entry.payload.data.replace(KILLED_EXIT, KILLED_EXIT_NORMALISED) };
  }
  return phones;
}
