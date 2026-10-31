import { useMemo, useSyncExternalStore } from 'react';
import type { RouteSessionChoice } from './route-editor-panes';
import { t } from './i18n';
import { getComposerStyle, subscribeComposerStyle } from './composer-style-preference';

export type RouteLabelParts = { workflow: string; mode: string };

/** This device's Display → Composer style. */
export function useComposerStyle() {
  return useSyncExternalStore(subscribeComposerStyle, getComposerStyle, () => 'detail' as const);
}

/** The label's parts when the composer style is "detail" and the conversation
 *  has a delegation mode; the workflow is empty while only one workflow exists
 *  (useSessionRouteChoices leaves its row out then). */
export function useRouteLabelParts(sessionChoices: RouteSessionChoice[] | undefined): RouteLabelParts | null {
  const enabled = useComposerStyle() === 'detail';
  const mode = enabled ? sessionChoices?.find((choice) => choice.id === 'orchestration-mode')?.valueLabel : '';
  const workflow = enabled ? sessionChoices?.find((choice) => choice.id === 'workflow')?.valueLabel : '';
  return useMemo(() => (mode ? { workflow: workflow || '', mode } : null), [mode, workflow]);
}

/** The model trigger a route label stands in for: it sits in the label's line,
 *  or (a phone) in the card just above it. */
export function routeMenuTrigger(label: Element): HTMLElement | null {
  const line = label.closest('.composer-model-line');
  return (
    line?.querySelector<HTMLElement>('.model-trigger') ??
    line?.previousElementSibling?.querySelector<HTMLElement>('.model-trigger') ??
    null
  );
}

export function ComposerRouteLabel({ parts }: { parts: RouteLabelParts }) {
  const title = parts.workflow ? `${parts.workflow} · ${parts.mode}` : parts.mode;
  return (
    <button
      type="button"
      className="composer-route-label"
      data-menu-trigger-proxy=""
      title={title}
      aria-label={`${t('Workflow and delegation')}: ${title}`}
      onClick={(event) => routeMenuTrigger(event.currentTarget)?.click()}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <circle cx="8" cy="3.5" r="1.8" />
          <circle cx="3.5" cy="12.5" r="1.8" />
          <circle cx="12.5" cy="12.5" r="1.8" />
          <path d="M8 5.3v2.7M8 8L4.6 10.9M8 8l3.4 2.9" />
        </g>
      </svg>
      <span>
        {parts.workflow && <span className="composer-route-label-workflow">{`${parts.workflow} · `}</span>}
        {parts.mode}
      </span>
    </button>
  );
}
