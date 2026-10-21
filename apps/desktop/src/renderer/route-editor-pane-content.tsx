import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import type { DesktopModelOption } from '../shared/contract';
import { t } from './i18n';
import type { RouteSpeed } from './model-route-utils';
import { useContextDraft } from './route-editor-context';
import type { RouteSheetPane } from './route-editor-logic';
import {
  modelParameterLabel,
  moveRouteFocus,
  type RouteAutoEffort,
  type RouteSessionChoice,
  routeContextPane,
  routeEffortPane,
  routeParameterPane,
  routeSessionChoicePane,
  routeSpeedPane,
} from './route-editor-panes';
import { RoutePaneHeader } from './route-editor-sheet';

/** What each pane shows and how it is titled: effort, speed, context, one
 *  model parameter, or a conversation choice. Owns the context pane's draft
 *  and size-edit state. */
export function useRoutePaneContent({
  pane,
  drill,
  closePane,
  sheet,
  optionFlyout,
  sessionChoices,
  parameterRows,
  modelParameters,
  tuningDisabled,
  effort,
  effortOptions,
  autoEffort,
  autoEffortOn,
  speed,
  fastAvailable,
  ultrafastAvailable,
  contextPercent,
  contextDefaultPercent,
  contextTokens,
  contextExactTokens,
  contextMaxTokens,
  contextDefaultTokens,
  onChangeEffort,
  onChangeAutoEffort,
  onChangeSpeed,
  onChangeContext,
  onChangeModelParameter,
}: {
  pane: RouteSheetPane | null;
  drill: boolean;
  closePane(pane: RouteSheetPane, restoreFocus?: boolean): void;
  sheet: { current: HTMLDivElement | null };
  optionFlyout: { current: HTMLDivElement | null };
  sessionChoices: RouteSessionChoice[];
  parameterRows: NonNullable<DesktopModelOption['modelParameterOptions']>;
  modelParameters: Record<string, string>;
  tuningDisabled: boolean;
  effort: string;
  effortOptions: Array<{ value: string; label: string }>;
  autoEffort: RouteAutoEffort;
  autoEffortOn: boolean;
  speed: RouteSpeed;
  fastAvailable: boolean;
  ultrafastAvailable: boolean;
  contextPercent: number;
  contextDefaultPercent: number;
  contextTokens: number;
  contextExactTokens: number;
  contextMaxTokens: number;
  contextDefaultTokens: number;
  onChangeEffort(value: string): void;
  onChangeAutoEffort(enabled: boolean): void;
  onChangeSpeed(speed: RouteSpeed): void;
  onChangeContext(percent: number, tokens?: number): void;
  onChangeModelParameter?(id: string, value: string): void;
}) {
  const {
    setContextDraft,
    shownContextPercent,
    shownContextTokens,
    defaultContextTokens,
    commitContextDraft,
    applyContextTokens,
    resetContextDefault,
    contextCustom,
  } = useContextDraft({
    pane,
    contextPercent,
    contextDefaultPercent,
    contextTokens,
    contextExactTokens,
    contextMaxTokens,
    contextDefaultTokens,
    onChangeContext,
  });
  const [contextEditing, setContextEditing] = useState(false);
  const contextCommitEdit = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (pane !== 'context') setContextEditing(false);
  }, [pane]);

  const sessionChoice = (target: RouteSheetPane) =>
    target.startsWith('session:') ? sessionChoices.find((choice) => `session:${choice.id}` === target) : undefined;
  const parameterFor = (target: RouteSheetPane) => parameterRows.find((entry) => `parameter:${entry.id}` === target);

  // A drilled pane replaced the sheet, so its first row walks back up one
  // level; a flyout that opened beside the sheet keeps the plain title.
  const paneHeader = (label: string, target: RouteSheetPane) => (
    <RoutePaneHeader
      label={label}
      drill={drill}
      tune={
        target === 'context' && contextMaxTokens
          ? {
              editing: contextEditing,
              disabled: tuningDisabled,
              onToggle: () => {
                if (contextEditing) contextCommitEdit.current?.();
                else setContextEditing(true);
              },
            }
          : undefined
      }
      onBack={() => closePane(target, true)}
    />
  );

  // Whichever surface currently hosts the open pane: the sheet itself while
  // drilled, the flyout beside it otherwise.
  const paneContainer = () =>
    sheet.current?.querySelector('.route-sheet-pane') ? sheet.current : optionFlyout.current;

  const paneLabel = (target: RouteSheetPane): string => {
    if (target === 'model') return t('Model');
    if (target === 'effort') return t('Reasoning effort');
    if (target === 'context') return t('Context');
    if (target === 'speed') return t('Speed');
    const choice = sessionChoice(target);
    if (choice) return choice.label;
    const parameter = parameterFor(target);
    return parameter ? modelParameterLabel(parameter) : '';
  };

  /** ArrowLeft walks back out of the pane it was pressed in; the other keys
   *  rove between its options. */
  const paneOptionKeyDown = (target: RouteSheetPane) => (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (moveRouteFocus(event, paneContainer(), '.route-sheet-option:not(:disabled)')) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      closePane(target, true);
    }
  };

  const paneBody = (target: RouteSheetPane): ReactNode => {
    if (target === 'effort') {
      return routeEffortPane({
        effort,
        effortOptions,
        autoEffort,
        autoEffortOn,
        tuningDisabled,
        onChangeEffort,
        onChangeAutoEffort,
        onOptionKeyDown: paneOptionKeyDown('effort'),
      });
    }
    if (target === 'speed') {
      return routeSpeedPane({
        speed,
        fastAvailable,
        ultrafastAvailable,
        tuningDisabled,
        onChangeSpeed,
        onOptionKeyDown: paneOptionKeyDown('speed'),
      });
    }
    if (target === 'context') {
      return routeContextPane({
        contextDefaultPercent,
        defaultContextTokens,
        contextMaxTokens,
        shownContextPercent,
        shownContextTokens,
        contextCustom,
        editing: contextEditing,
        commitEditRef: contextCommitEdit,
        tuningDisabled,
        onEditEnd: () => setContextEditing(false),
        onApplyTokens: applyContextTokens,
        onCommitDraft: commitContextDraft,
        onDraftChange: setContextDraft,
        onResetDefault: resetContextDefault,
      });
    }
    const choice = sessionChoice(target);
    if (choice) return routeSessionChoicePane({ choice, onOptionKeyDown: paneOptionKeyDown(target) });
    const parameter = parameterFor(target);
    if (!parameter) return null;
    return routeParameterPane({
      parameter,
      value: modelParameters[parameter.id],
      tuningDisabled,
      onChangeModelParameter,
      onOptionKeyDown: paneOptionKeyDown(target),
    });
  };

  return { paneLabel, paneHeader, paneBody };
}
