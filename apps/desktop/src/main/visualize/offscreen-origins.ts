/**
 * Off-screen pages, each at an origin of its own on one shared session.
 *
 * Electron never frees a session (electron/electron#28566), so a partition
 * per page kept its network context, with the pooled sockets of its load, for
 * the life of the app. A shared session with one origin shares that origin's
 * storage between pages instead. Chromium keys every origin-scoped store
 * (local storage, IndexedDB, cache storage, cookies, service workers) by
 * origin, so a never-reused `<id>.localhost` origin per page keeps it apart
 * from every other page, alongside or later, with nothing left to clear in
 * time. The session answers those origins itself (its `http` handler): no
 * name lookup and no socket group per origin. `*.localhost` is potentially
 * trustworthy, as the loopback page server is, so a page keeps its secure
 * context.
 */
import { randomBytes } from 'node:crypto';
import type { Session } from 'electron';

/** Answers one request to an open origin (`url` is the request's own). */
export type OriginServer = (url: URL, request: Request) => Promise<Response> | Response;

export interface OffscreenOrigin {
  /** `http://<id>.localhost`, never handed out again. */
  origin: string;
  /** Stops serving the origin and drops what its page stored. */
  release(): Promise<void>;
}

export interface OffscreenOrigins {
  open(serve: OriginServer): OffscreenOrigin;
}

const ORIGIN_HOST = /^[\da-f]{32}\.localhost$/;

/** Whether `url` is at an origin of this module's kind (any page's). */
export function isOffscreenOriginUrl(url: string): boolean {
  try {
    return ORIGIN_HOST.test(new URL(url).host);
  } catch {
    return false;
  }
}

/** Takes over `session`'s `http` scheme: an open origin's requests go to its
 *  server, a released or unknown one of ours is not found, and any other
 *  `http` request goes to `other`. */
export function offscreenOrigins(
  session: Session,
  other: (request: Request) => Promise<Response> | Response
): OffscreenOrigins {
  const servers = new Map<string, OriginServer>();
  session.protocol.handle('http', (request) => {
    const url = new URL(request.url);
    const serve = servers.get(url.host);
    if (serve) return serve(url, request);
    return ORIGIN_HOST.test(url.host) ? new Response(null, { status: 404 }) : other(request);
  });
  return {
    open(serve) {
      const host = `${randomBytes(16).toString('hex')}.localhost`;
      servers.set(host, serve);
      const origin = `http://${host}`;
      return {
        origin,
        async release() {
          servers.delete(host);
          // The origin is never used again: this only frees its memory.
          await session.clearData({ origins: [origin] });
        },
      };
    },
  };
}
