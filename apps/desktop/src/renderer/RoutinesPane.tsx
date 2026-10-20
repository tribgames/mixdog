// The Routines tile of an agent's home thread: the schedules that agent owns,
// then its webhooks, each kind one grouped list. A row is a status dot, the
// name (with a 실패 / 멈춤 tag) and one line — cadence and next run, or the
// sender and latest event; run now, pause / resume, retry delivery and delete
// live in its ⋯ menu. Routines are added and changed by asking the agent in
// the chat.
import { type ReactNode, useState } from 'react';

import { agentIdOfHomeSession } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import type { DesktopApi } from '../shared/contract';
import { t } from './i18n';
import { InitialSurface } from './InitialSurface';
import { type AgentProfileApi, AgentProfilePane } from './AgentProfilePane';
// The panel's chunk warms the profile when a bot tab turns active (use-app-workbench-views).
export { prefetchAgentProfile } from './AgentProfilePane';
import { setAgentPanelTab, useAgentPanelTab } from './agent-panel-tab';
import { showDesktopToast } from './notifications';
import { record, rows } from './record-utils';
import { type RoutineRow, routineRows, type WebhookRoutineRow, webhookRoutineRows } from './routines-model';
import { describeSchedule } from './SchedulesView';
import { webhookSourceLabel } from './WebhooksView';
import { RoutineItem, type RowControls, relativeTime } from './routine-list-item';
import { useSidebarReferences } from './sidebar-reference-cache';
import { useSidebarCapabilityRunner } from './use-sidebar-capability-runner';
import './settings/settings.css';
import './routines.css';

type RoutinesApi = Partial<Pick<DesktopApi, 'invokeCapability'>>;

const ROUTINES_REFERENCE_KEYS = ['channelSetup'] as const;

function ScheduleItem({ row, ...controls }: RowControls & { row: RoutineRow }) {
  const cadence = describeSchedule(row.source);
  const detail =
    row.pausedAfter !== null
      ? t('Paused after {{n}} failures in a row', { n: row.pausedAfter })
      : !row.enabled
        ? t('{{cadence}} · Paused', { cadence })
        : row.nextAt !== null
          ? t('{{cadence}} · Next {{time}}', { cadence, time: relativeTime(row.nextAt) })
          : cadence;
  return (
    <RoutineItem {...controls} name={row.name} enabled={row.enabled} last={row.last} detail={detail} health={row} />
  );
}

function WebhookItem({ row, ...controls }: RowControls & { row: WebhookRoutineRow }) {
  const detail =
    row.pausedAfter !== null
      ? t('Paused after {{n}} failures in a row', { n: row.pausedAfter })
      : row.eventAt !== null
        ? t('{{source}} events · Latest {{time}}', {
            source: webhookSourceLabel(row.parser),
            time: relativeTime(row.eventAt),
          })
        : t('No events');
  return (
    <RoutineItem
      {...controls}
      name={row.name}
      enabled={row.enabled}
      last={row.last}
      detail={detail}
      health={row}
      runBlocked={row.hasPayload ? '' : t('No payload received yet.')}
    />
  );
}

/** One kind's rows; the caller leaves out a kind with none. */
function RoutineSection({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="conn-group">
      <div className="conn-group-head">
        <h4>
          {title}
          <span>{count}</span>
        </h4>
      </div>
      <div className="conn-list">{children}</div>
    </section>
  );
}

/** A home thread's agent panel: 프로필 · 루틴 tabs over the profile
 *  (AgentProfilePane.tsx) and the routines below. The tab is remembered. */
export function AgentPanel({
  sessionId,
  active,
  api = window.mixdogDesktop,
  leafId,
}: {
  sessionId: string;
  active: boolean;
  api?: RoutinesApi & AgentProfileApi;
  /** The pane whose dock header carries the profile's ⋯ actions. */
  leafId?: string;
}) {
  const tab = useAgentPanelTab();
  return (
    <div className="agent-panel" hidden={!active || undefined}>
      <div className="agent-panel-tabs" role="tablist" aria-label={t('Bot')}>
        {(['profile', 'routines'] as const).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setAgentPanelTab(id)}>
            {id === 'profile' ? t('Profile') : t('Routines')}
          </button>
        ))}
      </div>
      {/* Both tabs stay mounted (and loaded): switching only flips `hidden`. */}
      <div className="agent-panel-view" hidden={tab !== 'profile' || undefined}>
        <AgentProfilePane
          key={sessionId}
          sessionId={sessionId}
          active={active}
          shown={tab === 'profile'}
          api={api}
          leafId={leafId}
        />
      </div>
      <div className="agent-panel-view" hidden={tab !== 'routines' || undefined}>
        <RoutinesPane sessionId={sessionId} active={active} api={api} />
      </div>
    </div>
  );
}

export function RoutinesPane({
  sessionId,
  active,
  api = window.mixdogDesktop,
}: {
  sessionId: string;
  active: boolean;
  api?: RoutinesApi;
}) {
  const { values, loading, completeMutation } = useSidebarReferences(api, ROUTINES_REFERENCE_KEYS, active);
  const { pending, run } = useSidebarCapabilityRunner({ api, completeMutation, toastScope: 'routines' });
  // `${kind}:${name}` of the run this tile started and still waits on.
  const [runningKey, setRunningKey] = useState('');
  const agentId = agentIdOfHomeSession(sessionId);
  const setup = record(values.channelSetup);
  const schedules = routineRows(rows(setup.schedules), agentId);
  const webhooks = webhookRoutineRows(rows(setup.webhooks), agentId);
  const runNow = async (capability: 'runScheduleNow' | 'runWebhookNow', name: string) => {
    if (!api?.invokeCapability || runningKey) return;
    setRunningKey(`${capability}:${name}`);
    try {
      await api.invokeCapability({ capability, args: [name] });
      showDesktopToast(t('"{{name}}" finished. Its result is in this chat.', { name }), 'success');
    } catch (reason) {
      showDesktopToast(reason instanceof Error ? reason.message : String(reason), 'error', {
        scope: `routines:run:${name}`,
      });
    } finally {
      setRunningKey('');
      void completeMutation(capability);
    }
  };
  const busy = Boolean(pending);
  return (
    <div className="routines-pane" hidden={!active || undefined}>
      {loading ? (
        <InitialSurface />
      ) : !schedules.length && !webhooks.length ? (
        <p className="utility-dock-empty">{t('No routines.')}</p>
      ) : (
        <>
          {schedules.length > 0 && (
            <RoutineSection title={t('Schedules')} count={schedules.length}>
              {schedules.map((row) => (
                <ScheduleItem
                  key={row.name}
                  row={row}
                  running={runningKey === `runScheduleNow:${row.name}`}
                  busy={busy}
                  onToggle={(enabled) => void run('setScheduleEnabled', [row.name, enabled], 'toast')}
                  onRun={() => void runNow('runScheduleNow', row.name)}
                  onRetryDelivery={() => void run('retryRoutineDelivery', ['schedule', row.name], 'toast')}
                  onDelete={() => void run('deleteSchedule', [row.name], 'toast')}
                />
              ))}
            </RoutineSection>
          )}
          {webhooks.length > 0 && (
            <RoutineSection title={t('Webhooks')} count={webhooks.length}>
              {webhooks.map((row) => (
                <WebhookItem
                  key={row.name}
                  row={row}
                  running={runningKey === `runWebhookNow:${row.name}`}
                  busy={busy}
                  onToggle={(enabled) => void run('setWebhookEnabled', [row.name, enabled], 'toast')}
                  onRun={() => void runNow('runWebhookNow', row.name)}
                  onRetryDelivery={() => void run('retryRoutineDelivery', ['webhook', row.name], 'toast')}
                  onDelete={() => void run('deleteWebhook', [row.name], 'toast')}
                />
              ))}
            </RoutineSection>
          )}
        </>
      )}
    </div>
  );
}
