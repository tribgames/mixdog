// `DesktopApi.sections` on the phone: the renderer's section store reads the client library's fold store directly, where the
// Electron window reads main's mirror of it. Everything is attached once the client is up, so a listener added at mount (before the
// first connection) still hears the first snapshot.
import type { PhoneBoot } from './phone-boot.ts';
import { createFsWatchCalls } from './phone-fs-watches.ts';
import { createLoginFlows } from './phone-login-flows.ts';
import { createSectionLink, type Client } from './phone-section-link.ts';
import {
  EVENT_SECTIONS,
  SECTION_NAMES,
  type DesktopProtocolStatus,
  type DesktopSectionsApi,
  type DesktopSectionEntry,
  type DesktopSectionsPush,
} from '../../desktop/src/shared/contract-sections.ts';

/** The sections the page's store carries. Not `notice`: a phone is shown a desktop notice only as it is raised, never one standing
 *  when it connected, so the phone's notices come from the notifications adapter (remote-protocol-notifications.ts) as raises the
 *  connected client hears, through `subscribeDesktopNotices`, not from held entries. */
const NAMES = SECTION_NAMES.filter((name) => name !== 'notice');

const statusOf = (client: Client): DesktopProtocolStatus => {
  const state = client.status.state;
  return state === 'ready' ? 'ready' : state === 'closed' ? 'closed' : 'reconnecting';
};

/** The renderer's adapter from a fold store to a pushes source (section-store-model.ts), passed in so this module needs none of the renderer. */
export type SectionsFromFoldStore = (
  store: Client['store'],
  names: readonly string[],
  status: () => DesktopProtocolStatus
) => { subscribe(listener: (push: DesktopSectionsPush) => void): () => void };

export function createPhoneSections(
  boot: Pick<PhoneBoot, 'start' | 'client' | 'onClient'>,
  sectionsSourceFromFoldStore: SectionsFromFoldStore
): DesktopSectionsApi {
  const link = createSectionLink(boot);
  const { upWith, notifications, currentClient } = link;
  // A tell is not state: a phone whose leg was down is not told what was pushed meanwhile (the relay does not replay it), so the
  // state it hands out holds none; its page reads again on its own reconnect.
  const entriesOf = (client: Client): DesktopSectionEntry[] =>
    NAMES.filter((name) => !EVENT_SECTIONS.includes(name)).flatMap((name) => [...client.store.sections(name)]);
  const logins = createLoginFlows(link);
  const pushListeners = new Set<(push: DesktopSectionsPush) => void>();
  const call = createFsWatchCalls(link, (push) => {
    for (const listener of [...pushListeners]) listener(push);
  });

  return {
    core: async () => true,
    snapshot: async () => {
      const client = await currentClient();
      return { status: statusOf(client), entries: entriesOf(client), epoch: client.store.appFeed()?.epoch };
    },
    subscribe: (listener) => {
      pushListeners.add(listener);
      const stop = upWith((client, current) => {
        const push = (value: DesktopSectionsPush): void => {
          if (current()) listener(value);
        };
        const replace = (): void => {
          push({ kind: 'replace', stage: 'begin' });
          push({ kind: 'replace', stage: 'chunk', entries: entriesOf(client) });
          push({ kind: 'replace', stage: 'commit', epoch: client.store.appFeed()?.epoch });
        };
        const source = sectionsSourceFromFoldStore(client.store, NAMES, () => statusOf(client));
        const offs = [
          source.subscribe(push),
          client.on((event) => {
            if (event.type === 'status') push({ kind: 'status', status: statusOf(client) });
          }),
          // A whole app snapshot was folded after a reconnect: the held store is swapped for it at once.
          client.store.subscribe((change) => {
            if (current() && change.type === 'appSnapshot') replace();
          }),
        ];
        replace();
        push({ kind: 'status', status: statusOf(client) });
        return () => {
          for (const off of offs) off();
        };
      });
      return () => {
        pushListeners.delete(listener);
        stop();
      };
    },
    call,
    subscribeFsChanged: (listener) =>
      upWith((client, current) =>
        notifications(client, current, 'fs/changed', (params) =>
          listener({
            watchId: String(params.watchId ?? ''),
            changedPaths: Array.isArray(params.changedPaths) ? params.changedPaths.map(String) : [],
            ...(typeof params.kind === 'string' ? { kind: params.kind } : {}),
          })
        )
      ),
    subscribeLoginUpdated: logins.subscribeUpdated,
    subscribeLoginFeedLost: logins.subscribeLost,
    loginFeed: async (flowId) => {
      await boot.start();
      return logins.read(flowId);
    },
  };
}
