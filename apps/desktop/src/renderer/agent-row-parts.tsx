import { Bot } from 'lucide-react';
import type React from 'react';
import { useRef, useState } from 'react';
import type { DesktopAgentPoolRow } from '../shared/contract';
import { cachedAutoEffortCapable } from './auto-effort-store';
import { beginPaneDrag, finishPaneDrag, type PaneDragSession } from './pane-drag-session';
import { modelDisplayName, ModelRouteLabel, ProviderIcon, routeDaybreakBlue } from './provider-display';

/** The brand of the model an agent runs on marks its row; `size` enlarges it
 *  for an avatar. */
export function AgentProviderMark({
  agent,
  size = 16,
}: {
  agent: Pick<DesktopAgentPoolRow, 'provider'>;
  size?: number;
}) {
  return (
    <span className="sidebar-resource-icon" aria-hidden="true">
      {agent.provider ? (
        <ProviderIcon provider={String(agent.provider)} width={size} height={size} />
      ) : (
        <Bot size={size} />
      )}
    </span>
  );
}

/** A row with a session is a pane source, exactly like a sidebar session row:
 *  dropping it inside a pane opens the session as a tab and dropping it on a
 *  pane edge splits a new pane there. A settled drag must not also fire the
 *  row's open click, which `clickSuppressed` reports. */
export function useSessionDragSource(sessionId: string, title: string, botId?: string) {
  const [dragging, setDragging] = useState(false);
  const suppressClick = useRef(false);
  return {
    clickSuppressed: () => suppressClick.current,
    dragProps: {
      draggable: Boolean(sessionId || botId),
      'data-dragging': dragging ? 'true' : undefined,
      onDragStart(event: React.DragEvent<HTMLElement>) {
        if (!sessionId && !botId) {
          event.preventDefault();
          return;
        }
        // A bot row with no session yet is the same drag, reorder-only: its
        // bot list takes it, the pane workspace ignores it.
        const drag: PaneDragSession = {
          kind: 'session',
          key: sessionId ? `session:${sessionId}` : `bot:${botId}`,
          title,
          selection: { kind: 'session', id: sessionId, title },
          ...(botId ? { botId } : {}),
          ...(sessionId ? {} : { reorderOnly: true }),
        };
        // The gesture settles in the global drag session, so this cleanup still
        // runs when the pool retires this row mid-drag.
        beginPaneDrag(
          event.nativeEvent,
          drag,
          // A control inside the row (the face toggle) drags the whole row.
          event.currentTarget.closest<HTMLElement>('[data-drag-frame="row"]') ?? event.currentTarget,
          () => {
            setDragging(false);
            suppressClick.current = true;
            window.setTimeout(() => {
              suppressClick.current = false;
            }, 0);
            delete document.body.dataset.tabDragging;
          }
        );
        setDragging(true);
        document.body.dataset.tabDragging = '1';
      },
      onDragEnd() {
        finishPaneDrag();
      },
    },
  };
}

/** An agent row's second line: model and effort. */
export function AgentRouteSummary({ agent }: { agent: DesktopAgentPoolRow }) {
  const modelParameters = agent.modelParameters as Record<string, string> | undefined;
  return (
    <small className="agent-route-summary" title={String(agent.model || '') || undefined}>
      <ModelRouteLabel
        model={modelDisplayName(String(agent.model || ''), String(agent.provider || ''))}
        effort={String(agent.effort || '').trim()}
        fast={agent.fast === true}
        ultra={modelParameters?.serviceTier === 'ultrafast'}
        blue={routeDaybreakBlue(modelParameters)}
        autoEffortCapable={cachedAutoEffortCapable(String(agent.provider || ''), String(agent.model || ''))}
        autoEffort={agent.autoEffort}
      />
    </small>
  );
}
