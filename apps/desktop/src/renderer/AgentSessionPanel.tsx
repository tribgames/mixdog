// The side dock's agent session view: a sub-agent's live conversation opened
// beside its chat from the Agents window (streaming, tool rows, its question
// cards and composer), under the dock's shared header row.
import type React from 'react';
import { useRef } from 'react';
import { PanelTop } from 'lucide-react';
import { t } from './i18n';
import { DockHeaderRow } from './pane-dock-chrome';
import { defaultSessionLaneStore, useSessionLane } from './session-lane-store';
import type { AgentSessionPanelTarget } from './session-side-surface-policy';
import './agent-session-panel.css';

type HeldLane = NonNullable<ReturnType<typeof useSessionLane>>;

/** `sessionId`'s last live snapshot once its lane was torn down (the session
 *  ended for good or was deleted) while this panel showed it, else null. The
 *  copy is this panel's own: the shared store is never written, so nothing
 *  it derives (live or approval sessions) changes. A fresh live frame ends
 *  it. */
export function useHeldSessionLane(sessionId: string, store = defaultSessionLaneStore): HeldLane | null {
  const lane = useSessionLane(sessionId, store);
  const retained = useRef<{ sessionId: string; snapshot: HeldLane } | null>(null);
  if (lane) retained.current = { sessionId, snapshot: lane };
  const last = retained.current;
  return !lane && sessionId && last?.sessionId === sessionId ? last.snapshot : null;
}

export function AgentSessionPanel({
  target,
  active,
  renderConversation,
  onOpenAsTab,
  onClose,
}: {
  target: AgentSessionPanelTarget;
  active: boolean;
  /** The pane conversation surface for the sub-agent; `held` (its last
   *  snapshot, shown read-only) once it can no longer take input. */
  renderConversation(sessionId: string, title: string, held: HeldLane | null): React.ReactNode;
  onOpenAsTab(): void;
  onClose(): void;
}) {
  const held = useHeldSessionLane(target.sessionId);
  const title = target.title || t('Agent session');
  return (
    <section className="agent-session-panel" aria-label={title} hidden={!active || undefined}>
      <DockHeaderRow
        className="session-diff-header"
        left={
          <span className="dock-header-title" data-tooltip={title}>
            {title}
          </span>
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
      <div className="agent-session-panel-body">
        {renderConversation(target.sessionId, target.title, held)}
      </div>
    </section>
  );
}
