// Info rows the session panel and a New Task's panel share: a route choice
// row and the Model row. Kept out of the panel's lazy chunk, so a New Task's
// panel draws them in the commit that shows it.
import { Folder, Users, Workflow } from 'lucide-react';
import { type ComponentProps, useRef, useState } from 'react';
import { ServerAccountBadge } from './ComposerFooter';
import { ComposerRouteChoices } from './composer-route-choices';
import { t } from './i18n';
import { ModelSelector } from './model-controls';
import type { RouteSessionChoice } from './route-editor-panes';
import { openOnArrow, RailPickMark } from './session-rail-parts';

export type RailModelProps = Omit<
  ComponentProps<typeof ModelSelector>,
  'answersModelPickerRequests' | 'sheetAlign' | 'sheetPlacement' | 'sessionChoices' | 'triggerRowLabel'
>;

const CHOICE_ICONS: Record<string, typeof Workflow> = { 'orchestration-mode': Users, project: Folder };

/** A Workflow or Delegation row (a New Task's Project too): the route label's own choices, under the row. */
export function ChoiceRow({ choice }: { choice: RouteSessionChoice }) {
  const row = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const Icon = CHOICE_ICONS[choice.id] ?? Workflow;
  return (
    <>
      <button
        ref={row}
        type="button"
        className="session-rail-row session-rail-pick"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-disabled={choice.disabled || undefined}
        title={choice.label}
        onKeyDown={(event) => openOnArrow(event, open, () => !choice.disabled && setOpen(true))}
        onClick={() => {
          if (!choice.disabled) setOpen(!open);
        }}
      >
        <Icon size={14} className="session-rail-ic" aria-hidden="true" />
        <span className="sr-only">{choice.label}</span>
        <span className="session-rail-cut">{choice.valueLabel}</span>
        <RailPickMark />
      </button>
      {open && (
        <ComposerRouteChoices
          anchor={row}
          choices={[choice]}
          side="below"
          align="start"
          onClose={(restoreFocus) => {
            setOpen(false);
            if (restoreFocus) row.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </>
  );
}

export function ModelRow({
  model,
  answersModelPickerRequests,
}: {
  model: RailModelProps;
  answersModelPickerRequests: boolean;
}) {
  return (
    <div className="session-rail-model">
      <ModelSelector
        {...model}
        answersModelPickerRequests={answersModelPickerRequests}
        sheetAlign="start"
        sheetPlacement="below"
        triggerRowLabel={t('Model')}
      />
      <ServerAccountBadge />
    </div>
  );
}
