import { Bot } from 'lucide-react';
import type React from 'react';
import { useMemo, useRef, useState } from 'react';
import type { DesktopAgentPoolRow } from '../shared/contract';
import { cachedAutoEffortCapable, useAutoEffortMasterOn, useModelCatalogRevision } from './auto-effort-store';
import { cachedAgentTierRoute, cachedModelRow } from './model-catalog-cache';
import { beginPaneDrag, finishPaneDrag, type PaneDragSession } from './pane-drag-session';
import {
  agentRouteProvider,
  modelDisplayName,
  ModelRouteLabel,
  modelRouteDisplayParts,
  ProviderIcon,
  routeDaybreakBlue,
} from './provider-display';

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

/** What an agent row's model line shows, given the Auto reasoning master
 *  switch and whether the catalog marks its model capable; null when it
 *  shows nothing. */
function agentRouteView(agent: DesktopAgentPoolRow, autoOn: boolean, capable: boolean) {
  if (!agent.provider || !agent.model || agent.status === 'unknown') return null;
  // An external agent's effort is the tier of the model it runs; Auto and a speed are not its to take.
  if (agentRouteProvider(agent.provider)) {
    return {
      model: modelDisplayName(agent.model, agent.provider, cachedModelRow(agent.provider, agent.model)?.display),
      // A route saved under the agent's own id of one tier runs that tier.
      effort: String(agent.effort || '').trim() || cachedAgentTierRoute(agent.provider, agent.model)?.effort || '',
      effortLabel: '',
      fast: false,
      ultra: false,
      blue: false,
      observedAuto: false,
    };
  }
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

type AgentRouteView = NonNullable<ReturnType<typeof agentRouteView>>;

/** An agent row's second line: model and effort. */
export function AgentRouteSummary({ agent }: { agent: DesktopAgentPoolRow }) {
  const catalog = useModelCatalogRevision();
  const { provider, model } = agent;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the catalog read is what `catalog` counts; a catalog that arrives later draws the line again.
  const capable = useMemo(
    () => Boolean(provider && model && cachedAutoEffortCapable(provider, model)),
    [provider, model, catalog]
  );
  const view = agentRouteView(agent, useAutoEffortMasterOn(capable), capable);
  if (!view) return null;
  return <AgentRouteLabel view={view} title={String(agent.model || '')} />;
}

/** The words of an agent's model line ("Claude Opus 4.5 High Fast"), for a row that shows no model line; empty when
 *  the line would show nothing. */
export function useAgentRouteText(agent: DesktopAgentPoolRow): string {
  const catalog = useModelCatalogRevision();
  const { provider, model } = agent;
  // biome-ignore lint/correctness/useExhaustiveDependencies: as AgentRouteSummary: the catalog read is what `catalog` counts.
  const capable = useMemo(
    () => Boolean(provider && model && cachedAutoEffortCapable(provider, model)),
    [provider, model, catalog]
  );
  return routeWords(agentRouteView(agent, useAutoEffortMasterOn(capable), capable));
}

/** The model line's words every one of `agents` whose route is known shows (a kind's agents on one route); empty
 *  when they differ or none is known. */
export function useSharedRouteText(agents: readonly DesktopAgentPoolRow[]): string {
  const catalog = useModelCatalogRevision();
  const routes = agents.map(({ provider, model }) => `${provider || ''}\u0000${model || ''}`).join('\u0001');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `routes` names what is read; the catalog read is what `catalog` counts.
  const capable = useMemo(
    () => agents.map(({ provider, model }) => Boolean(provider && model && cachedAutoEffortCapable(provider, model))),
    [routes, catalog]
  );
  const master = useAutoEffortMasterOn(capable.some(Boolean));
  const texts = new Set(
    agents.map((agent, index) => routeWords(agentRouteView(agent, master, capable[index] ?? false))).filter(Boolean)
  );
  return texts.size === 1 ? [...texts][0] : '';
}

function routeWords(view: ReturnType<typeof agentRouteView>): string {
  if (!view) return '';
  const parts = modelRouteDisplayParts(view.model, view.effort, view.fast, view.effortLabel);
  const words = [
    parts.model,
    view.blue ? 'Blue' : '',
    parts.effort,
    parts.fast ? (view.ultra ? 'Ultrafast' : parts.fast) : '',
  ].filter(Boolean);
  return `${words.join(' ')}${view.observedAuto ? ' · Auto' : ''}`;
}

/** A route view drawn as the row's model line; `title` is the model's own id. */
function AgentRouteLabel({ view, title }: { view: AgentRouteView; title: string }) {
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
