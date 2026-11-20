// This window's link to its own core, as the connection reports it (core-direct/sections.ts pushes `status` with the ladder's
// attempt and, once the connection is closed, why). A server window's link to its daemon is connection-link-store.ts.
import { useEffect, useState } from 'react';

import type { DesktopCoreLink, DesktopProtocolStatus } from '../shared/contract-sections';

/** A reconnect shorter than this is not worth a banner or a blocked composer: the core restarting quickly is a blink. */
export const CORE_LINK_GRACE_MS = 3_000;

export interface CoreLinkView {
  readonly status: DesktopProtocolStatus;
  readonly link: DesktopCoreLink;
}

const UP: CoreLinkView = { status: 'ready', link: { attempt: 0, closed: null } };

/** The link, and whether it has been down long enough to say so (a closed connection says so at once). A first start
 *  that is still opening is not down: the window's own start says it is loading. */
export function useCoreLink(grace: number = CORE_LINK_GRACE_MS): { view: CoreLinkView; down: boolean } {
  const [view, setView] = useState<CoreLinkView>(UP);
  const [late, setLate] = useState(false);
  // Whether the connection was ever up: until then the window is starting, not reconnecting.
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    const sections = window.mixdogDesktop?.sections;
    if (!sections) return undefined;
    let live = true;
    let pushed = false;
    const apply = (status: DesktopProtocolStatus, link: DesktopCoreLink | undefined): void => {
      if (!live) return;
      setView({ status, link: link ?? UP.link });
      if (status === 'ready') setOpened(true);
    };
    const off = sections.subscribe((push) => {
      if (push.kind !== 'status') return;
      pushed = true;
      apply(push.status, push.link);
    });
    // What a push already said is newer than the read.
    void sections
      .snapshot()
      .then((held) => (pushed ? undefined : apply(held.status, held.link)))
      .catch(() => undefined);
    return () => {
      live = false;
      off();
    };
  }, []);
  const notReady = view.status !== 'ready';
  useEffect(() => {
    if (!notReady) {
      setLate(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setLate(true), grace);
    return () => window.clearTimeout(timer);
  }, [notReady, grace]);
  return { view, down: notReady && ((late && opened) || view.status === 'closed') };
}

/** Opens the window's core connection anew; the connection's own status reports how it goes. */
export function reconnectCore(): Promise<void> {
  return window.mixdogDesktop?.sections?.reconnect?.() ?? Promise.resolve();
}
