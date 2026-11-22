// A New Task's session panel: its Info card, holding the pickers the context
// bar under its composer holds without the panel. Drawn from the main chunk,
// so the pickers are there in the commit that shows the panel.
import { BranchChip, type BranchChipProps } from './BranchChip';
import { useBranchMenuData } from './branch-menu-data';
import { type ProjectContextProps, projectContextChoice } from './composer-support';
import { t } from './i18n';
import {
  type OrchestrationModePickProps,
  useOrchestrationModeChoice,
  useWorkflowChoice,
  type WorkflowPickProps,
} from './model-controls';
import { useFoldedModelPickerRequest, useSessionRailFolds } from './session-rail-folds';
import { openOnArrow, RailPickMark, RailSection } from './session-rail-parts';
import { ChoiceRow, ModelRow, type RailModelProps } from './session-rail-rows';

/** What a New Task's context chips act on, handed to its panel's Info rows. */
export type DraftRailContext = {
  project: ProjectContextProps;
  workflow: WorkflowPickProps;
  delegation: OrchestrationModePickProps;
  branch: BranchChipProps;
};

/** A New Task's Info category: the context chips under its composer (project,
 *  branch, workflow, delegation) and its model, as the session's Info rows. */
export function DraftInfoSection({
  open,
  onToggle,
  draft,
  model,
  answersModelPickerRequests,
}: {
  open: boolean;
  onToggle(): void;
  draft: DraftRailContext;
  model: RailModelProps;
  answersModelPickerRequests: boolean;
}) {
  const project = projectContextChoice(draft.project);
  const projectLabel = draft.project.activePath ? project.valueLabel : t('No project');
  const { choice: workflow } = useWorkflowChoice(draft.workflow);
  const delegation = useOrchestrationModeChoice(draft.delegation);
  // The Branch row's read, held while Info is folded too: its answer arms
  // the New Task default worktree the first message starts in.
  useBranchMenuData({
    draft: true,
    projectPath: draft.branch.projectPath,
    sessionId: '',
    intentKey: draft.branch.draftId || 'default',
    refreshKey: draft.branch.refreshKey ?? '',
  });
  return (
    <RailSection
      category="info"
      title={t('Info')}
      open={open}
      onToggle={onToggle}
      summary={<span className="session-rail-cut">{projectLabel}</span>}
    >
      <ChoiceRow choice={{ ...project, valueLabel: projectLabel }} />
      <BranchChip
        {...draft.branch}
        renderTrigger={(button, view) => (
          <button
            {...button}
            type="button"
            className="session-rail-row session-rail-pick"
            title={t('Branch')}
            onKeyDown={(event) => openOnArrow(event, Boolean(button['aria-expanded']), view.toggle)}
          >
            {view.icon('session-rail-ic')}
            <span className="sr-only">{t('Branch')}</span>
            <span className="session-rail-cut">{view.label}</span>
            <RailPickMark />
          </button>
        )}
      />
      <ModelRow
        model={model}
        answersModelPickerRequests={answersModelPickerRequests}
      />
      {workflow && <ChoiceRow choice={workflow} />}
      {delegation && <ChoiceRow choice={delegation} />}
    </RailSection>
  );
}

/** The panel's body for a New Task: its Info card alone, until the first
 *  message makes the session and the session's cards take its place. */
export function DraftRail({
  draft,
  model,
  answersModelPickerRequests,
}: {
  draft: DraftRailContext;
  model: RailModelProps;
  answersModelPickerRequests: boolean;
}) {
  const folds = useSessionRailFolds('');
  useFoldedModelPickerRequest(answersModelPickerRequests, folds.isOpen('info'), () => folds.toggle('info'));
  return (
    <div className="session-rail-content">
      <DraftInfoSection
        open={folds.isOpen('info')}
        onToggle={() => folds.toggle('info')}
        draft={draft}
        model={model}
        answersModelPickerRequests={answersModelPickerRequests}
      />
    </div>
  );
}
