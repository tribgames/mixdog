// Mixy is the Agents page's default selection on desktop: showing the page
// over a tab that is not a home thread brings Mixy's thread forward, without
// ever closing a tab the user is working in. Phones stay list-first.
import {
  agentHomeSessionId,
  isAgentHomeSessionId,
  MIXY_AGENT_ID,
} from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import type { WorkspaceSelection } from './nav-types';
import { navigationKey } from './text-format';

export interface AgentsPageFocus {
  /** The focused pane's active selection (null: no pane or no tab). */
  focused: WorkspaceSelection | null;
  /** How many tabs the focused pane holds. */
  focusedTabCount: number;
  /** Sessions open as tabs in any pane. */
  openSessionIds: readonly string[];
}

export type MixyDefaultPlan =
  | { kind: 'none' }
  /** A home thread is already open: focus it (prefers Mixy's). */
  | { kind: 'focus'; sessionId: string }
  /** Resolve Mixy's home and open it, replacing `replaceKey` when set. */
  | { kind: 'open'; replaceKey: string };

export function mixyDefaultPlan(
  page: AgentsPageFocus,
  { mobile, draftHasContent }: { mobile: boolean; draftHasContent(scope: string): boolean }
): MixyDefaultPlan {
  if (mobile) return { kind: 'none' };
  const { focused } = page;
  if (focused?.kind === 'session' && isAgentHomeSessionId(focused.id)) return { kind: 'none' };
  const blankDraft = focused?.kind === 'new' && !draftHasContent(`draft:${focused.draftId || 'default'}`);
  const mixyId = agentHomeSessionId(MIXY_AGENT_ID);
  const homes = page.openSessionIds.filter((id) => isAgentHomeSessionId(id));
  if (homes.length > 0) {
    // A home tab exists: reuse it from an untouched draft; a tab in use keeps
    // the focus.
    return blankDraft ? { kind: 'focus', sessionId: homes.includes(mixyId) ? mixyId : homes[0] } : { kind: 'none' };
  }
  // The only tab an untouched draft: Mixy takes its place, no second tab.
  if (blankDraft && focused && page.focusedTabCount <= 1) return { kind: 'open', replaceKey: navigationKey(focused) };
  return { kind: 'open', replaceKey: '' };
}
