// The service side of the global lists (session list, agent pool). Each
// publication goes out twice over: as today's whole-list message to every
// client that has not read the list's row feed (tagged with the feed position,
// for a row client that has not read yet on this connection), and — on a daemon with row
// feeds — as its row frames plus a publication marker to the clients that have.
// Clients are told apart by the registry's client epoch; a registry that
// cannot route delivers both to everyone; a row client keeps a whole list only
// when it is newer than its rows (list-row-store.ts).
import type { DesktopAgentPoolRow, DesktopSessionSummary } from '../shared/contract';
import type { DesktopServiceOutbound } from './desktop-service-protocol';
import { listPublishedMarker, type ListRowFeed, type ListRowName, type ServiceDelivery } from './list-row-adapter';

interface ListRowsByName {
  sessions: DesktopSessionSummary;
  'agent-pool': DesktopAgentPoolRow;
}

interface Lane {
  feed: ListRowFeed | undefined;
  /** Client epochs that read this list's row feed. */
  rowClients: Set<number>;
  publications: number;
  /** The feed's position after the last publication. */
  position: { epoch: string; seq: number } | null;
  /** The host read answering a read before any publication, shared by every such read. */
  hostRead: Promise<unknown[]> | null;
}

/** Today's whole-list message; on a lane with a row feed it also names the
 *  feed position the list stands at, so a row client that is sent it — before
 *  the service has handled its read, or from a registry that cannot route —
 *  can keep it in order with the frames and the read's answer. */
function wholeList(list: ListRowName, rows: unknown[], position?: { epoch: string; seq: number }): DesktopServiceOutbound {
  return list === 'sessions'
    ? { kind: 'sessions', sessions: rows as DesktopSessionSummary[], ...position }
    : { kind: 'agent-pool', agents: rows as DesktopAgentPoolRow[], ...position };
}

export function createGlobalListPublisher({
  emit,
  listRowFeed,
}: {
  emit(message: DesktopServiceOutbound, delivery?: ServiceDelivery): void;
  listRowFeed?(list: ListRowName): ListRowFeed;
}) {
  const lane = (list: ListRowName): Lane => ({
    feed: listRowFeed?.(list),
    rowClients: new Set(),
    publications: 0,
    position: null,
    hostRead: null,
  });
  const lanes: Record<ListRowName, Lane> = { sessions: lane('sessions'), 'agent-pool': lane('agent-pool') };

  const publish = <List extends ListRowName>(list: List, rows: ListRowsByName[List][]): void => {
    const target = lanes[list];
    target.publications += 1;
    if (!target.feed) {
      emit(wholeList(list, rows));
      return;
    }
    const rowClients = [...target.rowClients];
    const frames = target.feed.publish(rows);
    const last = frames.at(-1);
    if (last) target.position = { epoch: last.epoch, seq: last.seq };
    if (!target.position) {
      const { epoch, seq } = target.feed.read() as { epoch: string; seq: number };
      target.position = { epoch, seq };
    }
    const { epoch, seq } = target.position;
    emit(wholeList(list, rows, { epoch, seq }), { except: rowClients });
    const delivery = { to: rowClients };
    for (const frame of frames) emit(frame, delivery);
    emit(listPublishedMarker(list, epoch, seq), delivery);
  };

  return {
    publish,
    /** A client's read: the feed's answer `{ list, epoch, seq, rows }`. Before
     *  any publication the host is read once; a publication landing meanwhile
     *  is newer than that read and wins. */
    async read(list: unknown, epoch: unknown, readHost: () => Promise<unknown[]>): Promise<unknown> {
      if (list !== 'sessions' && list !== 'agent-pool') throw new TypeError('Mixdog desktop service method is unavailable.');
      const target = lanes[list];
      if (!target.feed) throw new TypeError('Mixdog desktop service method is unavailable.');
      if (Number.isSafeInteger(epoch)) target.rowClients.add(epoch as number);
      if (target.publications === 0) {
        const read = (target.hostRead ??= readHost().finally(() => {
          target.hostRead = null;
        }));
        const rows = await read;
        if (target.publications === 0) publish(list, rows as never[]);
      }
      return target.feed.read();
    },
    releaseClient(epoch: number): void {
      for (const target of Object.values(lanes)) target.rowClients.delete(epoch);
    },
  };
}
