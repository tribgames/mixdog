import { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ComposerRouteChoices } from './composer-route-choices';
import type { RouteSessionChoice } from './route-editor-panes';
import { t } from './i18n';
import { getComposerStyle, subscribeComposerStyle } from './composer-style-preference';
import { routeMenuTrigger } from './route-menu-trigger';

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

/** In the composer's line the label stands in for the model trigger beside it
 *  and opens its menu. Under the card (`choices`) the model trigger is a row
 *  away, so the label opens its own menu of those choices. */
export function ComposerRouteLabel({ parts, choices }: { parts: RouteLabelParts; choices?: RouteSessionChoice[] }) {
  const title = parts.workflow ? `${parts.workflow} · ${parts.mode}` : parts.mode;
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const own = Boolean(choices?.length);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="composer-route-label"
        data-menu-trigger-proxy={own ? undefined : ''}
        title={title}
        aria-label={`${t('Workflow and delegation')}: ${title}`}
        aria-haspopup={own ? 'menu' : undefined}
        aria-expanded={own ? open : undefined}
        onClick={(event) => {
          if (own) setOpen((value) => !value);
          else routeMenuTrigger(event.currentTarget)?.click();
        }}
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
      {open && choices && (
        <ComposerRouteChoices
          anchor={button}
          choices={choices}
          onClose={(restoreFocus) => {
            setOpen(false);
            if (restoreFocus) button.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </>
  );
}
