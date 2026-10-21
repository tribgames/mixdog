// The Workflows panel's agent rows (WorkflowsView.tsx): each agent's model
// route summarized, its leading mark, and the row itself.
import { Bot, ChevronRight, Globe } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { DesktopModelOption } from '../shared/contract';
import { isContactAgentRow } from '../shared/agent-contacts';
import type { RecordValue } from './desktop-types';
import { t } from './i18n';
import { preferredModelEffort } from './model-route-utils';
import { ModelRouteLabel, ProviderIcon, modelDisplayName, routeDaybreakBlue } from './provider-display';
import { record } from './record-utils';
import { contextMenuRowProps } from './ScmContextMenu';
import { SidebarResourceTitle } from './sidebar-resource-row';
import type { usePersistedListOrder } from './use-persisted-list-order';

type AgentRouteSummary = {
  model: string;
  effort: string;
  fast: boolean;
  ultra: boolean;
  blue: boolean;
  effortLabel: string;
  autoEffortCapable: boolean;
  autoEffort: boolean;
};

/** Web Search never runs per-call Auto reasoning: an explicit route sends its
 *  stored effort, and the default route inherits Main's effective effort. So
 *  its row never claims Auto, and the default marker says it follows Main. */
export function agentRouteSummary(
  route: RecordValue,
  models: DesktopModelOption[],
  { webSearch = false }: { webSearch?: boolean } = {}
): AgentRouteSummary {
  const provider = String(route.provider || '');
  const model = String(route.model || '');
  const selected = models.find((entry) => entry.provider === provider && entry.model === model);
  // Every row reads the same way (user: 웹검색만 왜 다르게 취급하냐): a row
  // with no model — Web Search's default marker or an empty route — says
  // "Default", and a set model shows its name.
  const pinned = model !== '' && !(provider === 'default' && model === 'default');
  const modelLabel = pinned
    ? modelDisplayName(model, provider, selected?.display || '')
    : webSearch
      ? t('Follows Main')
      : 'Default';
  const effortValue = String(route.effort || preferredModelEffort(selected) || '');
  const effortOption = selected?.effortOptions.find((entry) => entry.value === effortValue);
  const rawEffortLabel = effortOption?.label || effortValue;
  const fastCapable = selected?.fastCapable === true || typeof route.fast === 'boolean';
  const fast = typeof route.fast === 'boolean' ? route.fast : selected?.fastPreferred === true;
  return {
    model: modelLabel,
    effort: effortValue,
    fast: fastCapable && fast,
    ultra: fastCapable && fast && record(route.modelParameters).serviceTier === 'ultrafast',
    blue:
      pinned &&
      routeDaybreakBlue(record(route.modelParameters) as Record<string, string>, selected?.modelParameterOptions),
    effortLabel: rawEffortLabel,
    autoEffortCapable: !webSearch && selected?.autoEffortCapable === true,
    autoEffort: !webSearch && route.autoEffort !== false,
  };
}

/** The row's leading mark: the brand of the model it runs on, so flat rows
 *  part at a glance (user: 각각이 분리되어 보이지 않는데). A route with no
 *  pinned model — off, or following Main — shows the row's own glyph. */
export function AgentRowIcon({ route, fallback = 'agent' }: { route: RecordValue; fallback?: 'agent' | 'web' }) {
  const provider = String(route.provider || '');
  const pinned = provider !== '' && provider !== 'default' && String(route.model || '') !== '';
  let mark = <Bot size={16} />;
  if (pinned) mark = <ProviderIcon provider={provider} width={16} height={16} />;
  else if (fallback === 'web') mark = <Globe size={16} />;
  return (
    <span className="sidebar-resource-icon" aria-hidden="true">
      {mark}
    </span>
  );
}

export function AgentRouteSummaryView({ summary }: { summary: AgentRouteSummary }) {
  return (
    <small className="agent-route-summary route-trigger-copy">
      <ModelRouteLabel
        model={summary.model}
        effort={summary.effort}
        fast={summary.fast}
        ultra={summary.ultra}
        blue={summary.blue}
        effortLabel={summary.effortLabel}
        autoEffortCapable={summary.autoEffortCapable}
        autoEffort={summary.autoEffort}
      />
    </small>
  );
}

/** The agent's own route. The catalog's `route` falls back to Main, so a role
 *  the user never set would otherwise read (and save) as pinned to Main. */
export function ownRoute(row: RecordValue | undefined): RecordValue {
  return row?.routeConfigured === true ? record(row.route) : {};
}

export interface AgentSummary {
  id: string;
  label: string;
  description: string;
  custom: boolean;
  userOverride: boolean;
  /** A bot (agent-mode contact), listed on the Bots page instead. */
  contact: boolean;
}

/** The catalog's agents as rows; a row without an id is dropped. */
export function agentRosterOf(agents: readonly RecordValue[]): AgentSummary[] {
  return agents
    .map((agent) => ({
      id: String(agent.id || ''),
      label: String(agent.label || record(agent.definition).name || agent.id || ''),
      description: String(record(agent.definition).description || agent.description || ''),
      custom: agent.custom === true,
      userOverride: agent.userOverride === true,
      contact: isContactAgentRow(agent),
    }))
    .filter((agent) => agent.id);
}

/** One agent: its mark, name (tagged when switched off) and route summary;
 *  the click opens its settings, the context gesture its menu. A built-in
 *  shared-service agent (`builtIn`) is a route-only row in a fixed order. */
export function AgentRouteRow({
  agent,
  route,
  disabled,
  models,
  busy,
  builtIn,
  order,
  reorderProps,
  onOpen,
  onOpenMenu,
}: {
  agent: AgentSummary;
  route: RecordValue;
  disabled: boolean;
  models: DesktopModelOption[];
  busy: boolean;
  builtIn?: boolean;
  /** The built-in group's persisted order. */
  order?: number;
  reorderProps: ReturnType<ReturnType<typeof usePersistedListOrder>['getReorderProps']>;
  onOpen(): void;
  onOpenMenu(point: { x: number; y: number }): void;
}) {
  return (
    <button
      type="button"
      className={`schedules-row utilities-row sidebar-resource-row workflows-agent-summary-row${builtIn ? ' workflows-default-agent-summary-row' : ''}`}
      data-agent-id={builtIn ? agent.id : undefined}
      data-enabled={disabled ? 'false' : 'true'}
      style={builtIn ? ({ order } as CSSProperties) : undefined}
      data-tooltip={disabled ? t('Disabled') : t('Agent settings')}
      disabled={busy}
      aria-label={t('Edit {{name}}', { name: agent.label })}
      onClick={onOpen}
      {...contextMenuRowProps(onOpenMenu)}
      {...reorderProps}
    >
      <AgentRowIcon route={route} />
      <span className="schedules-row-copy utilities-row-copy">
        <SidebarResourceTitle label={agent.label} tag={disabled ? { label: t('Disabled'), tone: 'muted' } : null} />
        <AgentRouteSummaryView summary={agentRouteSummary(route, models)} />
      </span>
      <ChevronRight className="utilities-row-chevron" size={16} aria-hidden="true" />
    </button>
  );
}
