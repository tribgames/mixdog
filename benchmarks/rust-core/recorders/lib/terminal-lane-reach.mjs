// The script the terminal lane reach recording (record-terminal-lane-reach.mjs) and its replay against mixdogd (terminal-lane-reach-replay.mjs)
// share: the paired devices, the tabs, what is typed (each tab runs the scripted shell, which writes back each line it reads), and the one
// normalised value.

/** The three phones' credentials (each a paired device of its own). */
export const LANE_REACH_CREDENTIALS = { p1: 'aaaaaaa1', p2: 'aaaaaaa2', p3: 'aaaaaaa3' };
/** The tab the desktop opens, the tab the second phone opens (and disposes while it runs), and the tab whose shell ends by itself. */
export const LANE_REACH_TABS = { desktop: 'term_lane_desk', phone: 'term_lane_ph', ends: 'term_lane_end' };
/** A line typed into a tab, and what the scripted shell writes back for it. */
export const typed = (text) => `${text}\n`;
export const echoed = (text) => `${text}\r\n`;
/** The terminal lane's pushes as a Node phone gets them (remote-relay-push-lanes.ts:85, :139-150): each recorded per phone, in order. */
export const LANE_EVENTS = ['termData', 'termActivity', 'termSizeOwner'];

/** The exit line of a tab whose scripted shell a dispose ended: its code is how each side's stand-in ends the program (Node's: libuv's
 *  TerminateProcess, 1; the core's pipe-run tab: its job, 137), not the product's (a real console gives both the shell's own
 *  STATUS_CONTROL_C_EXIT: apps/mobile/fixtures/phone-terminal). Normalised in that tab's output only, on both sides. */
const KILLED_EXIT = /\[process exited with code -?\d+\]/g;
export const KILLED_EXIT_NORMALISED = '[process exited with code <ended by the dispose>]';
export function normaliseKilledExit(phones, tab) {
  for (const got of Object.values(phones)) {
    for (const entry of got.termData) {
      if (entry.payload?.id === tab) entry.payload = { ...entry.payload, data: entry.payload.data.replace(KILLED_EXIT, KILLED_EXIT_NORMALISED) };
    }
  }
  return phones;
}
