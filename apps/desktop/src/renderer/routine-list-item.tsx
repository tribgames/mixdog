// One routine row — the agent panel's 루틴 tab (RoutinesPane.tsx) and the side
// Schedules / Webhooks lists share it: an optional bot face, the status dot
// (or the running spinner), the name with a 실패 / 멈춤 tag, one line, and the
// ⋯ menu — run now, pause / resume, retry delivery (only after a refused
// delivery) and delete (confirmed in place).
import { type ReactNode, useEffect, useState } from 'react';

import { t, uiFormatLocale } from './i18n';
import { ProgressSpinner } from './ProgressSpinner';
import type { RoutineHealth, RoutineRow } from './routines-model';
import { RowOverflowMenu, rowOverflowHostProps } from './RowOverflowMenu';
import { timeFormatOptions } from './time-format-preference';

const when = (at: number) =>
  new Date(at).toLocaleString(uiFormatLocale(), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...timeFormatOptions(),
  });

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** "in 18 hours" / "3 minutes ago" within a week; a short date beyond. */
export function relativeTime(at: number): string {
  const diff = at - Date.now();
  if (Math.abs(diff) >= 7 * 86_400_000) return when(at);
  const format = new Intl.RelativeTimeFormat(uiFormatLocale(), { numeric: 'auto' });
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(diff) >= size) return format.format(Math.trunc(diff / size), unit);
  }
  return format.format(0, 'minute');
}

export interface RowControls {
  running: boolean;
  busy: boolean;
  onToggle(enabled: boolean): void;
  onRun(): void;
  onRetryDelivery(): void;
  onDelete(): void;
}

/** An armed delete falls back to idle after this long. */
const DELETE_CONFIRM_MS = 4000;

/** `runBlocked` disables the run with its reason; `held` shows a switched-on
 *  routine as paused (its bot is missing); `leading` is the row's bot face;
 *  `onOpen` makes the name and line open the routine's editor. */
export function RoutineItem({
  name,
  enabled,
  held = false,
  last,
  detail,
  health,
  runBlocked = '',
  leading,
  onOpen,
  running,
  busy,
  onToggle,
  onRun,
  onRetryDelivery,
  onDelete,
}: RowControls & {
  name: string;
  enabled: boolean;
  held?: boolean;
  last: RoutineRow['last'];
  detail: string;
  health: RoutineHealth;
  runBlocked?: string;
  leading?: ReactNode;
  onOpen?(): void;
}) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return undefined;
    const timer = setTimeout(() => setConfirming(false), DELETE_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirming]);
  const stopped = health.pausedAfter !== null;
  const failed = health.deliveryFailed !== null || last?.ok === false;
  const idleState = enabled && !held ? 'ok' : 'paused';
  const state = running ? 'running' : failed || stopped ? 'failed' : idleState;
  const items = [
    {
      id: 'run',
      label: t('Run now'),
      disabled: busy || running || Boolean(runBlocked),
      title: runBlocked || undefined,
      onSelect: onRun,
    },
    {
      id: 'toggle',
      label: enabled ? t('Pause routine') : t('Resume routine'),
      disabled: busy,
      onSelect: () => onToggle(!enabled),
    },
    ...(health.deliveryFailed
      ? [{ id: 'retry', label: t('Retry delivery'), disabled: busy, onSelect: onRetryDelivery }]
      : []),
    {
      id: 'delete',
      label: confirming ? t('Confirm delete') : t('Delete'),
      danger: true,
      separatorBefore: true,
      disabled: busy,
      closeOnSelect: confirming,
      onSelect: () => (confirming ? onDelete() : setConfirming(true)),
    },
  ];
  const dot = (
    <span className="routines-dot" aria-hidden="true">
      {running && <ProgressSpinner size={12} className="schedules-row-spinner" />}
    </span>
  );
  const main = (
    <>
      <span className="routines-title">
        {leading && dot}
        <b title={name}>{name}</b>
        {(stopped || failed) && (
          <span className="routines-tag" title={health.deliveryFailed?.error || undefined}>
            {stopped ? t('Auto-paused') : t('Failed')}
          </span>
        )}
      </span>
      <span className="routines-sub" title={running ? undefined : detail}>
        {running ? t('Running') : detail}
      </span>
    </>
  );
  return (
    <div
      className="routines-row"
      data-state={state}
      data-leading={leading ? 'true' : undefined}
      {...rowOverflowHostProps()}
    >
      {leading ?? dot}
      {onOpen ? (
        <button type="button" className="routines-main routines-open" disabled={busy} onClick={onOpen}>
          {main}
        </button>
      ) : (
        <div className="routines-main">{main}</div>
      )}
      <RowOverflowMenu label={name} items={items} />
    </div>
  );
}
