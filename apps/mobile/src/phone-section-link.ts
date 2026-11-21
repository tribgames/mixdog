import type { ClientEvent, ProtocolClient, SessionFold } from '../../../packages/protocol-client/src/index.ts';
import type { PhoneBoot } from './phone-boot.ts';

export type Client = ProtocolClient<SessionFold>;

export interface SectionLink {
  /** Runs `attach` for the client that is up now and for every replacement; `current` says whether the attachment still owns the page. */
  upWith(attach: (client: Client, current: () => boolean) => () => void): () => void;
  notifications(
    client: Client,
    current: () => boolean,
    method: string,
    listener: (params: Record<string, unknown>) => void
  ): () => void;
  rawCall(client: Client, method: string, params: unknown): Promise<unknown>;
  currentClient(): Promise<Client>;
}

export function createSectionLink(boot: Pick<PhoneBoot, 'start' | 'client' | 'onClient'>): SectionLink {
  // The installed phone removes its pairing overlay without reloading the page. Its API and listeners survive, but its
  // ProtocolClient does not. Never adopt the result of an old start promise after onClient has handed over to a new one.
  const upWith: SectionLink['upWith'] = (attach) => {
    let off: (() => void) | undefined;
    let stopped = false;
    let generation = 0;
    let held: Client | undefined;
    const offClient = boot.onClient((client) => {
      if (stopped || held === client) return;
      const turn = ++generation;
      off?.();
      held = client;
      const attached = attach(client, () => !stopped && generation === turn && boot.client() === client);
      if (!stopped && generation === turn) off = attached;
      else attached();
    });
    void boot.start().catch(() => undefined);
    return () => {
      stopped = true;
      generation++;
      offClient();
      off?.();
    };
  };
  const notifications: SectionLink['notifications'] = (client, current, method, listener) =>
    client.on((event: ClientEvent) => {
      if (current() && event.type === 'notification' && event.notification.method === method) {
        listener((event.notification.params ?? {}) as Record<string, unknown>);
      }
    });
  const rawCall: SectionLink['rawCall'] = async (client, method, params) =>
    (client.call as (method: string, params: unknown) => Promise<unknown>)(method, params);
  const currentClient = async (): Promise<Client> => {
    const started = await boot.start();
    return boot.client() ?? started.client;
  };
  return { upWith, notifications, rawCall, currentClient };
}
