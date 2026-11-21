import type { UiScreenSessionsChangedParams } from '@mixdog/protocol';
import { SCREEN_SESSIONS_CHANGED } from '../../../mobile/src/screen-reporter';
import type { PhoneProtocolAdapter, PhoneProtocolHost } from './remote-shim-protocol';

/** `filterSessionIds`'s reading of each item (desktop-state.ts:82-93): the core drops what is not a session id. */
const sessionIds = (value: unknown): string[] => (Array.isArray(value) ? value.map((item) => String(item || '')) : []);

const report = (host: PhoneProtocolHost, params: UiScreenSessionsChangedParams): void =>
  host.client().notify(SCREEN_SESSIONS_CHANGED, params);

export const adapter: PhoneProtocolAdapter = {
  group: 'screen',
  fires: {
    // `client.background = params[0] === false`; a string browser id replaces the last one (the core clips it to 64 units).
    setForeground: ([visible, browserId], host) =>
      report(host, { foreground: visible !== false, ...(typeof browserId === 'string' ? { browserId } : {}) }),
    setScreenSessions: ([ids], host) => report(host, { sessionIds: sessionIds(ids) }),
    setVisualizePanels: ([ids], host) => report(host, { visualizeSessionIds: sessionIds(ids) }),
    remotePerfPaint: () => undefined,
    // Node's PC read `String(params[0] ?? '')`.
    reportConnectionTimeline: ([text], host) =>
      host.client().notify('remote/connectionTimeline', { text: String(text ?? '') }),
  },
};
