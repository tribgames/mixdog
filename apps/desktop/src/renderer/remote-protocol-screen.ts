// The phone's relay plumbing calls (list 1 unit G), answered over the protocol as Node's relay answered them (b6f10295a:
// remote-relay-client-calls.ts:169-186 and :410-428). Node answered none of them: `setForeground`, `setScreenSessions` and
// `setVisualizePanels` each set one field of the phone's leg, which decides whether a push is held back for a conversation the
// phone shows and whether the phone counts as viewing a visualize panel; the core keeps the same fields from
// `ui/screenSessions/changed` (a report without a field leaves it as stated). `remotePerfPaint` acknowledged a paint probe the PC
// issued (it issues none unless its perf flag is on, and the core issues none), and `reportConnectionTimeline` was a PC log line:
// nothing reaches the core for either. The replay compares them with the recording
// (benchmarks/rust-core/recorders/record-phone-plumbing.mjs).
import type { UiScreenSessionsChangedParams } from '@mixdog/protocol';
import { SCREEN_SESSIONS_CHANGED } from '../../../mobile/src/screen-reporter';
import type { PhoneProtocolAdapter, PhoneProtocolHost } from './remote-shim-protocol';

/** `filterSessionIds`'s reading of each item (desktop-state.ts:82-93): the core drops what is not a session id. */
const sessionIds = (value: unknown): string[] => (Array.isArray(value) ? value.map((item) => String(item || '')) : []);

const report = (host: PhoneProtocolHost, params: UiScreenSessionsChangedParams): void => host.client().notify(SCREEN_SESSIONS_CHANGED, params);

export const adapter: PhoneProtocolAdapter = {
  group: 'screen',
  fires: {
    // `client.background = params[0] === false`; a string browser id replaces the last one (the core clips it to 64 units).
    setForeground: ([visible, browserId], host) =>
      report(host, { foreground: visible !== false, ...(typeof browserId === 'string' ? { browserId } : {}) }),
    setScreenSessions: ([ids], host) => report(host, { sessionIds: sessionIds(ids) }),
    setVisualizePanels: ([ids], host) => report(host, { visualizeSessionIds: sessionIds(ids) }),
    remotePerfPaint: () => undefined,
    reportConnectionTimeline: () => undefined,
  },
};
