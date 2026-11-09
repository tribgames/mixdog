// `DesktopApi.sections` on the phone: the renderer's section store reads the client library's fold store directly, where the
// Electron window reads main's mirror of it. Everything is attached once the client is up, so a listener added at mount (before the
// first connection) still hears the first snapshot.
import type { ClientEvent, ProtocolClient, SessionFold } from '../../../packages/protocol-client/src/index.ts';
import {
  SECTION_NAMES,
  type DesktopProtocolStatus,
  type DesktopSectionsApi,
  type DesktopSectionEntry,
  type DesktopSectionsPush,
  type RendererProtocolMethod,
} from '../../desktop/src/shared/contract-sections.ts';

type Client = ProtocolClient<SessionFold>;

const statusOf = (client: Client): DesktopProtocolStatus => {
  const state = client.status.state;
  return state === 'ready' ? 'ready' : state === 'closed' ? 'closed' : 'reconnecting';
};

/** The renderer's adapter from a fold store to a pushes source (section-store.ts), passed in so this module needs none of the renderer. */
export type SectionsFromFoldStore = (
  store: Client['store'],
  names: readonly string[],
  status: () => DesktopProtocolStatus
) => { subscribe(listener: (push: DesktopSectionsPush) => void): () => void };

export function createPhoneSections(boot: { start(): Promise<{ client: Client }> }, sectionsSourceFromFoldStore: SectionsFromFoldStore): DesktopSectionsApi {
  const upWith = (attach: (client: Client) => () => void): (() => void) => {
    let off: (() => void) | undefined;
    let stopped = false;
    void boot.start().then(({ client }) => {
      if (!stopped) off = attach(client);
    }, () => undefined);
    return () => {
      stopped = true;
      off?.();
    };
  };
  const notifications = (client: Client, method: string, listener: (params: Record<string, unknown>) => void): (() => void) =>
    client.on((event: ClientEvent) => {
      if (event.type === 'notification' && event.notification.method === method) {
        listener((event.notification.params ?? {}) as Record<string, unknown>);
      }
    });
  const entriesOf = (client: Client): DesktopSectionEntry[] => SECTION_NAMES.flatMap((name) => [...client.store.sections(name)]);
  // The last state of each sign-in flow's feed, and the flows whose feed was lost.
  const flows = new Map<string, unknown>();
  const lostFlows = new Set<string>();
  let tracking = false;
  const track = (): void => {
    if (tracking) return;
    tracking = true;
    void boot.start().then(({ client }) => {
    notifications(client, 'login/updated', (params) => {
      if (typeof params.flowId === 'string') flows.set(params.flowId, params.state);
    });
    client.store.subscribe((change) => {
      if (change.type === 'subscription' && change.state === 'lost' && change.feedId.startsWith('login:')) {
        lostFlows.add(change.feedId.slice('login:'.length));
      }
    });
    }, () => undefined);
  };

  return {
    core: async () => true,
    snapshot: async () => {
      const { client } = await boot.start();
      return { status: statusOf(client), entries: entriesOf(client) };
    },
    subscribe: (listener) =>
      upWith((client) => {
        const source = sectionsSourceFromFoldStore(client.store, SECTION_NAMES, () => statusOf(client));
        const offs = [
          source.subscribe(listener),
          client.on((event) => {
            if (event.type === 'status') listener({ kind: 'status', status: statusOf(client) } satisfies DesktopSectionsPush);
          }),
          // A whole app snapshot was folded after a reconnect: the held store is swapped for it at once.
          client.store.subscribe((change) => {
            if (change.type !== 'appSnapshot') return;
            listener({ kind: 'replace', stage: 'begin' });
            listener({ kind: 'replace', stage: 'chunk', entries: entriesOf(client) });
            listener({ kind: 'replace', stage: 'commit' });
          }),
        ];
        return () => offs.forEach((off) => off());
      }),
    call: async (method: RendererProtocolMethod, params: unknown) => {
      const { client } = await boot.start();
      return (client.call as (method: string, params: unknown) => Promise<unknown>)(method, params);
    },
    subscribeFsChanged: (listener) =>
      upWith((client) =>
        notifications(client, 'fs/changed', (params) =>
          listener({
            watchId: String(params.watchId ?? ''),
            changedPaths: Array.isArray(params.changedPaths) ? params.changedPaths.map(String) : [],
            ...(typeof params.kind === 'string' ? { kind: params.kind } : {}),
          })
        )
      ),
    subscribeLoginUpdated: (listener) => {
      track();
      return upWith((client) =>
        notifications(client, 'login/updated', (params) => {
          if (typeof params.flowId === 'string') listener({ flowId: params.flowId, state: params.state });
        })
      );
    },
    subscribeLoginFeedLost: (listener) => {
      track();
      return upWith((client) =>
        client.store.subscribe((change) => {
          if (change.type === 'subscription' && change.state === 'lost' && change.feedId.startsWith('login:')) {
            listener({ flowId: change.feedId.slice('login:'.length) });
          }
        })
      );
    },
    loginFeed: async (flowId) => {
      track();
      return { state: flows.get(flowId), lost: lostFlows.has(flowId) || !flows.has(flowId) };
    },
  };
}
