/**
 * The page-addressed action registry. Every name in the public contract that
 * targets a page resolves to exactly one handler here; the three session
 * bookkeeping actions (list_tabs, downloads, close_tab) never reach a page
 * and are answered by the host before dispatch.
 */
import { BROWSER_ACTIONS } from '../../../../../../src/runtime/browser-bridge/browser-action-contract.mjs';
import { TABLESS_ACTIONS } from '../command';
import { diagnosticActions } from './diagnostics';
import { flowActions } from './flow';
import { formActions } from './forms';
import { navigationActions } from './navigation';
import { observationActions } from './observe';
import { pageActions } from './page';
import { pointerActions } from './pointer';
import type { BrowserActionHandler } from './types';

export type {
  BrowserActionContext,
  BrowserActionHandler,
  BrowserActionServices,
} from './types';

export const BROWSER_ACTION_HANDLERS: Readonly<Record<string, BrowserActionHandler>> = Object.freeze({
  ...navigationActions,
  ...observationActions,
  ...pointerActions,
  ...formActions,
  ...pageActions,
  ...flowActions,
  ...diagnosticActions,
});

/** Contract names that must resolve to a page handler. */
export const PAGE_ACTIONS: readonly string[] = BROWSER_ACTIONS.filter(
  (action) => !TABLESS_ACTIONS.has(action),
);

export function browserActionHandler(action: string): BrowserActionHandler | undefined {
  return Object.hasOwn(BROWSER_ACTION_HANDLERS, action) ? BROWSER_ACTION_HANDLERS[action] : undefined;
}
