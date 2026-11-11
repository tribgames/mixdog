// The script the terminal lane reach recording (record-terminal-lane-reach.mjs) and its replay against mixdogd (terminal-lane-reach-replay.mjs)
// share: the paired devices, the tabs, the typed markers, and what a phone's output is checked for.

/** The two phones' credentials (each a paired device of its own). */
export const LANE_REACH_CREDENTIALS = { p1: 'aaaaaaa1', p2: 'aaaaaaa2' };
/** The tab the desktop opens, and the tab the second phone opens. */
export const LANE_REACH_TABS = { desktop: 'term_lane_desk', phone: 'term_lane_ph' };
/** What is typed (PowerShell joins the two halves, so only the command's output holds `seen`; its echo of the line does not). */
const mark = (name) => ({ typed: `echo ('LANE' + '-${name}')\r`, seen: `LANE-${name}` });
export const LANE_REACH_MARKS = { desktop: mark('DESK'), phone: mark('PH'), unpair: mark('UNPAIR') };

/** Whether a phone's text for a tab (`got`) starts with the tab's own text (`tab`, its replay buffer) up to the end of the first `seen`:
 *  the phone got the tab's output from its first output on, the marker's output included. */
export function reachOf(tab, got, seen) {
  const at = tab.indexOf(seen);
  if (at < 0) throw new Error(`the tab's own text does not hold ${seen}`);
  return { fromFirstOutput: got.startsWith(tab.slice(0, at + seen.length)) };
}
