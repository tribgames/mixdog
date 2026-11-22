import { Bot } from 'lucide-react';
import type React from 'react';
import { useMemo, useRef, useState } from 'react';
import type { DesktopAgentPoolRow } from '../shared/contract';
import { cachedAutoEffortCapable, useAutoEffortMasterOn } from './auto-effort-store';
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

const autoEffortCapable = (agent: DesktopAgentPoolRow) =>
  Boolean(agent.provider && agent.model && cachedAutoEffortCapable(agent.provider, agent.model));

/** What an agent row's model line shows, given the Auto reasoning master
 *  switch; null when it shows nothing. Equal views read the same. */
export function agentRouteView(agent: DesktopAgentPoolRow, autoOn: boolean, capable = autoOn && autoEffortCapable(agent)) {
  if (!agent.provider || !agent.model || agent.status === 'unknown') return null;
  const observed = agent.routeObserved === true;
  const auto = autoOn && capable && agent.autoEffort !== false;
  const modelParameters = agent.modelParameters as Record<string, string> | undefined;
  return {
    model: modelDisplayName(agent.model, agent.provider),
    // A configured route on Auto reads "Auto" for its level; a request it ran keeps that level and adds "· Auto".
    effort: auto && !observed ? '' : String(agent.effort || '').trim(),
    effortLabel: auto && !observed ? 'Auto' : '',
    fast: agent.fast === true,
    ultra: modelParameters?.serviceTier === 'ultrafast',
    blue: routeDaybreakBlue(modelParameters),
    observedAuto: observed && auto && agent.autoEffort === true,
  };
}

export type AgentRouteView = NonNullable<ReturnType<typeof agentRouteView>>;

/** The Auto reasoning master switch, read only when one of `agents` could show it;
 *  the catalog is read again only when the list or the catalog (`catalog`, its
 *  revision) changes. */
export function useAgentRouteAuto(agents: readonly DesktopAgentPoolRow[], catalog: number): boolean {
  // biome-ignore lint/correctness/useExhaustiveDependencies: `autoEffortCapable` reads the catalog `catalog` counts.
  const wanted = useMemo(() => agents.some(autoEffortCapable), [agents, catalog]);
  return useAutoEffortMasterOn(wanted);
}

/** An agent row's second line: model and effort. */
export function AgentRouteSummary({ agent }: { agent: DesktopAgentPoolRow }) {
  const capable = autoEffortCapable(agent);
  const view = agentRouteView(agent, useAutoEffortMasterOn(capable), capable);
  if (!view) return null;
  return <AgentRouteLabel view={view} title={String(agent.model || '')} />;
}

/** A route view drawn as the row's model line; `title` is the model's own id. */
export function AgentRouteLabel({ view, title }: { view: AgentRouteView; title: string }) {
  return (
    <small className="agent-route-summary" title={title || undefined}>
      <ModelRouteLabel
        model={view.model}
        effort={view.effort}
        effortLabel={view.effortLabel}
        fast={view.fast}
        ultra={view.ultra}
        blue={view.blue}
      />
      {view.observedAuto && <span className="model-route-label-effort"> · Auto</span>}
    </small>
  );
}
