import type { RefObject } from 'react';
import type { ComposerProps } from './Composer';
import { ComposerAddMenu } from './ComposerAddMenu';
import { ComposerGoalDialog } from './ComposerGoalDialog';
import { ModelSelector } from './model-controls';
import { DictationButton, SendButton } from './composer-surfaces';
import type { ComposerAttachment } from './composer-support';
import type { useComposerDictation } from './use-composer-dictation';
import type { useComposerSkill } from './composer-skill';
import type { useComposerPalettes } from './use-composer-palettes';

type ModelProps = Pick<
  ComposerProps,
  | 'provider'
  | 'model'
  | 'effort'
  | 'fast'
  | 'fastCapable'
  | 'modelParameters'
  | 'contextPercent'
  | 'sessionId'
  | 'invokeResult'
  | 'applySnapshot'
  | 'onOpenSettings'
  | 'onDraftModelSelection'
  | 'onRoutePreferenceApplied'
>;

/** The composer card's bottom row: attach/skill/goal menu, model controls,
 *  dictation and the send/stop disc. */
export function ComposerFooter({
  attachAccept,
  fileInput,
  onFilesChosen,
  textarea,
  paletteAnchor,
  recoveryScope,
  goalDialogOpen,
  setGoalDialogOpen,
  addMenuRequest,
  goalDisabled,
  executeSlash,
  transitioning,
  commandBusy,
  turnBusy,
  paneActive,
  hasConversation,
  submitting,
  skillSelection,
  mention,
  dictation,
  stopOnly,
  voiceSend,
  draft,
  attachments,
  onStop,
  modelAside,
  ...modelProps
}: ModelProps & {
  attachAccept: string;
  fileInput: RefObject<HTMLInputElement | null>;
  onFilesChosen: (files: FileList) => void;
  textarea: RefObject<HTMLTextAreaElement | null>;
  paletteAnchor: RefObject<HTMLFormElement | null>;
  recoveryScope: string;
  goalDialogOpen: boolean;
  setGoalDialogOpen: (open: boolean) => void;
  /** Bumped by /skills to open the add menu. */
  addMenuRequest: number;
  goalDisabled: boolean;
  executeSlash: (command: string) => Promise<boolean>;
  transitioning: boolean;
  commandBusy: boolean;
  turnBusy: boolean;
  paneActive: boolean;
  hasConversation: boolean;
  submitting: boolean;
  skillSelection: ReturnType<typeof useComposerSkill>;
  mention: ReturnType<typeof useComposerPalettes>['mention'];
  dictation: ReturnType<typeof useComposerDictation>;
  stopOnly: boolean;
  voiceSend: boolean;
  draft: string;
  attachments: ComposerAttachment[];
  onStop: () => void;
  modelAside: ComposerProps['modelAside'];
}) {
  const { sessionId, onOpenSettings } = modelProps;
  return (
    <div className="composer-footer">
      <input
        ref={fileInput}
        type="file"
        hidden
        multiple
        accept={attachAccept}
        onChange={(event) => {
          if (event.currentTarget.files) onFilesChosen(event.currentTarget.files);
          event.currentTarget.value = '';
        }}
      />
      {goalDialogOpen && (
        <ComposerGoalDialog
          anchor={textarea}
          disabled={goalDisabled}
          onStart={executeSlash}
          onClose={() => setGoalDialogOpen(false)}
          returnFocus={() => textarea.current?.focus()}
        />
      )}
      <ComposerAddMenu
        key={recoveryScope}
        anchor={paletteAnchor}
        sessionId={sessionId}
        disabled={transitioning || !paneActive}
        goalDisabled={goalDisabled}
        openRequest={addMenuRequest}
        onAttach={() => fileInput.current?.click()}
        onSkill={(name) => {
          skillSelection.select(name);
          mention.setDismissed(mention.signature);
          queueMicrotask(() => textarea.current?.focus());
        }}
        onGoal={executeSlash}
        onMore={() => onOpenSettings('skills')}
      />
      <ModelSelector
        {...modelProps}
        // Model writes are queued by the session API. A preceding write must
        // not disable the next selection while its acknowledgement travels.
        modelDisabled={transitioning}
        answersModelPickerRequests={paneActive}
        // Effort/Fast stay live during a turn: the running turn already
        // captured its own effort/fast at turn start, so a change here lands
        // on the NEXT turn instead of being locked out. Only session-command
        // churn still disables the controls.
        tuningDisabled={commandBusy || transitioning}
      />
      {modelAside && <span className="composer-model-aside">{modelAside}</span>}
      <span className="composer-primary-actions">
        {/* The mic appears only once the voice runtime is installed
            (Extensions → Voice transcription): an uninstalled feature never
            advertises itself in the composer. */}
        {dictation.dictationInstalled && (
          <DictationButton
            state={dictation.dictationState}
            disabled={transitioning || dictation.dictationState === 'transcribing'}
            onToggle={() => void dictation.toggleDictation()}
          />
        )}
        <SendButton
          stopOnly={stopOnly}
          voiceSend={voiceSend}
          submitting={submitting}
          turnBusy={turnBusy}
          commandBusy={commandBusy}
          transitioning={transitioning}
          hasConversation={hasConversation}
          dictationState={dictation.dictationState}
          draft={draft}
          attachments={attachments}
          onStop={onStop}
          onStopDictationAndSend={() => void dictation.stopDictationAndSend()}
        />
      </span>
    </div>
  );
}
