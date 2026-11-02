// The side dock's agent session view: a sub-agent's live conversation opened
// beside its chat from the Agents window (streaming, tool rows, its question
// cards and composer), under the dock's shared header row.
import type React from 'react';
import { useRef } from 'react';
import { PanelTop } from 'lucide-react';
import { t } from './i18n';
import { sessionTabGlyph } from './WorkspaceTabStrip';
import { DockHeaderRow } from './pane-dock-chrome';
import { defaultSessionLaneStore, useSessionLane } from './session-lane-store';
import type { AgentSessionPanelTarget } from './session-side-surface-policy';
import './agent-session-panel.css';

type HeldLane = NonNullable<ReturnType<typeof useSessionLane>>;

/** `sessionId`'s last live snapshot once its lane was torn down (the session
 *  ended for good or was deleted) while a panel showed it, else null. The
 *  copy is the panel's own: the shared store is never written, so nothing
 *  it derives (live or approval sessions) changes. A fresh live frame ends
 *  it. `retained` is the panel targets' map (heldAgentLanes), which outlives
 *  this component remounting on a host chat switch; its owner releases an
 *  entry with its panel target. */
export function useHeldSessionLane(
  sessionId: string,
  store = defaultSessionLaneStore,
  retained?: Map<string, HeldLane>
): HeldLane | null {
  const lane = useSessionLane(sessionId, store);
  const own = useRef(new Map<string, HeldLane>());
  const kept = retained ?? own.current;
  if (lane) kept.set(sessionId, lane);
  return !lane && sessionId ? (kept.get(sessionId) ?? null) : null;
}

export function AgentSessionPanel({
  target,
  active,
  heldLanes,
  renderConversation,
  onOpenAsTab,
  onClose,
}: {
  target: AgentSessionPanelTarget;
  active: boolean;
  /** Where the sub-agent's final snapshot is kept (see useHeldSessionLane). */
  heldLanes?: Map<string, HeldLane>;
  /** The pane conversation surface for the sub-agent; `held` (its last
   *  snapshot, shown read-only) once it can no longer take input. */
  renderConversation(sessionId: string, title: string, held: HeldLane | null): React.ReactNode;
  onOpenAsTab(): void;
  onClose(): void;
}) {
  const held = useHeldSessionLane(target.sessionId, defaultSessionLaneStore, heldLanes);
  const title = target.title || t('Agent session');
  return (
    <section className="agent-session-panel" aria-label={title} hidden={!active || undefined}>
      <DockHeaderRow
        className="session-diff-header"
        left={
          <div className="browser-tab is-active dock-header-chip">
            <span className="browser-tab-select" title={title}>
              {sessionTabGlyph(target.sessionId)}
              <span>{title}</span>
            </span>
          </div>
        }
        actions={[
          {
            id: 'open-in-tab',
            label: t('Open in tab'),
            // The browser panel's "Open in main tab" glyph.
            icon: PanelTop,
            inline: true,
            onSelect: onOpenAsTab,
          },
        ]}
        onClose={onClose}
      />
      <div className="agent-session-panel-body">{renderConversation(target.sessionId, target.title, held)}</div>
    </section>
  );
}
