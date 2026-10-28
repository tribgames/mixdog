// The quiet-time cue on the desktop: the live status line says how long a
// running turn has gone without counted progress and what it waits on, and
// offers Stop once the silence reaches the stall watchdog's warn point.
// Display only: Stop is the ordinary session abort the user asks for.
import type React from 'react';
import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { QuietProgressParts } from '../../../../src/runtime/shared/quiet-progress.mjs';
import { t } from './i18n';
import { showDesktopToast } from './notifications';
import { defaultSessionLaneStore } from './session-lane-store';
import { asRecord } from './text-format';
import { uiTimeUnit } from './ui-format';

/** The published quiet state of a session's live turn, read straight from its
 *  lane. A silence changes nothing but `spinner.quiet`, and the transcript
 *  shell that hands the status line its snapshot does not re-render on spinner
 *  fields, so the status line subscribes to this one value itself. `fallback`
 *  covers a status line without a lane (no session id, or not cached). */
export function useLaneSpinnerQuiet(sessionId: string, fallback: unknown): unknown {
  const cached = useRef<{ key: string; value: unknown }>({ key: '', value: undefined });
  const subscribe = useCallback(
    (listener: () => void) => (sessionId ? defaultSessionLaneStore.subscribe(sessionId, listener) : () => {}),
    [sessionId]
  );
  // Every frame carries a fresh copy of the same quiet state; keyed by its
  // fields, a streaming token never re-renders the status line.
  const quiet = useSyncExternalStore(subscribe, () => {
    const lane = sessionId ? defaultSessionLaneStore.get(sessionId) : null;
    const value = lane ? (asRecord(lane.spinner)?.quiet ?? null) : undefined;
    const record = asRecord(value);
    const key = !lane ? 'none' : record ? `${record.since}|${record.wait}|${record.tool}|${record.warnMs}` : 'null';
    if (cached.current.key !== key) cached.current = { key, value };
    return cached.current.value;
  });
  return quiet === undefined ? (fallback ?? null) : quiet;
}

function quietWaitText(parts: QuietProgressParts): string {
  if (parts.wait === 'provider') return t('waiting on provider');
  if (parts.wait === 'thinking') return t('model thinking');
  if (parts.wait === 'model') return t('waiting on model');
  if (parts.wait === 'slot') return t('waiting for a slot');
  if (parts.wait === 'cancel') return t('stopping');
  if (parts.wait === 'tool') {
    return parts.tool ? t('running {{tool}}', { tool: parts.tool }) : t('running a tool');
  }
  return '';
}

/** "Quiet for 2 min · waiting on provider". */
export function quietCueText(parts: QuietProgressParts): string {
  const quiet = t('No updates for {{duration}}', { duration: uiTimeUnit(parts.minutes, 'minute') });
  const wait = quietWaitText(parts);
  return wait ? `${quiet} · ${wait}` : quiet;
}

function stopSession(sessionId: string): void {
  void window.mixdogDesktop.abortSession(sessionId).catch((reason: unknown) => {
    showDesktopToast(reason instanceof Error ? reason.message : String(reason), 'error');
  });
}

/** The cue itself; escalated, it carries the Stop control. Stop is a span
 *  with the button role because agent rows are buttons themselves.
 *  `className` names the surface (live status line, agent row). */
export function QuietCue({
  parts,
  sessionId,
  className,
}: {
  parts: QuietProgressParts;
  sessionId: string;
  className: string;
}): React.ReactElement {
  const stop = (event: React.SyntheticEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    if (sessionId) stopSession(sessionId);
  };
  return (
    <span className={`quiet-cue ${className}`} data-escalated={parts.escalated ? 'true' : undefined}>
      <span>{quietCueText(parts)}</span>
      {parts.escalated && sessionId ? (
        // biome-ignore lint/a11y/useSemanticElements: agent rows are <button>s, so a nested <button> is invalid; the span carries the button role and keyboard activation
        <span
          role="button"
          tabIndex={0}
          className="quiet-cue-stop"
          onClick={stop}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') stop(event);
          }}
        >
          {t('Stop')}
        </span>
      ) : null}
    </span>
  );
}
