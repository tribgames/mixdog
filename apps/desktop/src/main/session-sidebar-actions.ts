// Sidebar session actions (favorite, archive, move to project) with their one
// argument validation, shared by the window IPC and the remote methods; the
// runtime's `session` tool reaches favorite/archive through the
// session-sidebar host channel.
import type { DesktopService } from './desktop-service-contract';
import { requiredSessionId } from './desktop-state';

type SidebarHost = Pick<DesktopService, 'setSessionArchived' | 'setSessionFavorite' | 'setSessionProject'>;

export function sessionSidebarActions(host: Partial<SidebarHost>) {
  return {
    setSessionArchived(sessionId: unknown, archived: unknown): unknown {
      if (typeof archived !== 'boolean') throw new TypeError('archived must be a boolean.');
      return host.setSessionArchived!(requiredSessionId(sessionId), archived);
    },
    setSessionFavorite(sessionId: unknown, favorite: unknown): unknown {
      if (typeof favorite !== 'boolean') throw new TypeError('favorite must be a boolean.');
      return host.setSessionFavorite!(requiredSessionId(sessionId), favorite);
    },
    setSessionProject(sessionId: unknown, projectPath: unknown): unknown {
      if (typeof projectPath !== 'string') throw new TypeError('projectPath must be a string.');
      return host.setSessionProject!(requiredSessionId(sessionId), projectPath);
    },
  };
}

/** The host the runtime's session-sidebar channel calls: one change object,
 *  `{ favorite }`, `{ archived }` (validated as above), `{ archived: true,
 *  cascade: false }` (that session alone: the daemon's sub-agent retention) or
 *  `{ forgotten: true }` (a session the daemon's store deleted on its own). */
export function sessionSidebarChangeHandler(
  host: Partial<SidebarHost> & {
    archiveSessionAlone?(sessionId: string): unknown;
    forgetSessionMetadata?(sessionId: string): unknown;
  }
) {
  const actions = sessionSidebarActions(host);
  return async (sessionId: unknown, change: unknown): Promise<void> => {
    const value = (change && typeof change === 'object' ? change : {}) as Record<string, unknown>;
    if (Object.hasOwn(value, 'favorite')) await actions.setSessionFavorite(sessionId, value.favorite);
    else if (value.archived === true && value.cascade === false)
      await host.archiveSessionAlone!(requiredSessionId(sessionId));
    else if (Object.hasOwn(value, 'archived')) await actions.setSessionArchived(sessionId, value.archived);
    else if (value.forgotten === true) await host.forgetSessionMetadata!(requiredSessionId(sessionId));
    else throw new TypeError('Session sidebar change is invalid.');
  };
}
