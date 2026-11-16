import type { DesktopModelSelection } from './contract';

/** The `setRoute` selection of a picker write, as Node's host sent it (`session-host-lifecycle.ts` `setModelRoute`): it applies
 *  to the current session, and keeps the Main model when a conversation is addressed; a pick with none is the Main model's. */
export const modelRouteWrite = (selection: DesktopModelSelection, sessionId?: string) => ({
  ...selection,
  applyToCurrentSession: true,
  keepMainModel: Boolean(sessionId),
});
