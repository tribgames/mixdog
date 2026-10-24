import { memo, useCallback, type ReactNode, type RefObject } from 'react';
import { useStableCallback } from './use-stable-callback';
import type { ComposerProps } from './Composer';
import { ComposerAddMenu } from './ComposerAddMenu';
import type { RoomMemberLabel } from './agent-room-parts';
import { ComposerGoalDialog } from './ComposerGoalDialog';
import { ModelSelector } from './model-controls';
import { persistAgentChatRoute } from './agent-chat-route';
import { errorMessageText } from './ErrorNotice';
import { showDesktopToast } from './notifications';
import { DictationButton, SendButton } from './composer-surfaces';
import { useConnectionLink } from './connection-link-store';
import { t } from './i18n';
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
  | 'autoEffort'
  | 'modelParameters'
  | 'contextPercent'
  | 'contextTokens'
  | 'sessionId'
  | 'invokeResult'
  | 'applySnapshot'
  | 'onOpenSettings'
  | 'onDraftModelSelection'
  | 'onRoutePreferenceApplied'
  | 'sessionChoices'
>;

export type ComposerModelControlProps = ModelProps & {
  modelAside: ComposerProps['modelAside'];
  agentMode?: boolean;
  transitioning: boolean;
  commandBusy: boolean;
  paneActive: boolean;
  /** The edge the model sheet lines up with: 'end' at the line's right end. */
  sheetAlign?: 'start' | 'end';
};

/** A server window whose models run with the server's own logins says so
 *  beside the model name: its sessions use none of this PC's accounts. */
export function ServerAccountBadge() {
  const link = useConnectionLink();
  if (link?.modelLogin !== 'server') return null;
  return <span className="composer-server-account">{t('Server account')}</span>;
}

/** The model picker and the context gauge beside it. In an agent chat every
 *  route change also lands on the agent itself (agent-chat-route.ts), so the
 *  chip and the agent's profile pane stay one setting. */
export const ComposerModelControls = memo(function ComposerModelControls({
  modelAside,
  agentMode = false,
  transitioning,
  commandBusy,
  paneActive,
  onRoutePreferenceApplied,
  sheetAlign,
  ...modelProps
}: ComposerModelControlProps) {
  const { sessionId } = modelProps;
  const applyAgentRoute = useCallback<NonNullable<ModelProps['onRoutePreferenceApplied']>>(
    (selection, options) => {
      onRoutePreferenceApplied?.(selection, options);
      persistAgentChatRoute(String(sessionId || ''), selection).catch((reason) =>
        showDesktopToast(errorMessageText(reason), 'error')
      );
    },
    [onRoutePreferenceApplied, sessionId]
  );
  return (
    <span className="composer-model-line-controls">
      <ServerAccountBadge />
      <ModelSelector
        {...modelProps}
        sheetAlign={sheetAlign}
        // Model writes are queued by the session API. A preceding write must
        // not disable the next selection while its acknowledgement travels.
        modelDisabled={transitioning}
        answersModelPickerRequests={paneActive}
        // Effort/Fast stay live during a turn: the running turn already
        // captured its own effort/fast at turn start, so a change here lands
        // on the NEXT turn instead of being locked out. Only session-command
        // churn still disables the controls.
        tuningDisabled={commandBusy || transitioning}
        onRoutePreferenceApplied={agentMode ? applyAgentRoute : onRoutePreferenceApplied}
      />
      {modelAside && <span className="composer-model-aside">{modelAside}</span>}
    </span>
  );
});

/** The slim line UNDER the composer card: the usage readout on the left, the
 *  model picker and the context gauge on the right. A phone's coding composer
 *  carries the model controls in its card instead (`controls` false), so the
 *  line holds the readout alone. */
export const ComposerModelLine = memo(function ComposerModelLine({
  usageReadout,
  room = false,
  controls = true,
  ...controlProps
}: ComposerModelControlProps & {
  usageReadout?: ReactNode;
  /** A group room: its members each use their own model, so the line shows
   *  neither the model picker nor the context gauge. */
  room?: boolean;
  controls?: boolean;
}) {
  if (room) return usageReadout ? <div className="composer-model-line">{usageReadout}</div> : null;
  return (
    <div className="composer-model-line">
      {usageReadout}
      {/* At the line's right end the pill grows leftwards: its sheet shares its right edge. */}
      {controls && <ComposerModelControls {...controlProps} sheetAlign="end" />}
    </div>
  );
});

/** The composer card's bottom row: attach/skill/goal menu, dictation and the
 *  send/stop disc. */
export function ComposerFooter({
  attachAccept,
  fileInput,
  onFilesChosen,
  textarea,
  paletteAnchor,
  recoveryScope,
  projectScope,
  goalDialogOpen,
  setGoalDialogOpen,
  addMenuRequest,
  roomMembers = null,
  onAskMember,
  goalDisabled,
  executeSlash,
  transitioning,
  paneActive,
  hasConversation,
  submitting,
  skillSelection,
  mention,
  dictation,
  stopOnly,
  voiceSend,
  sendable,
  onStop,
  agentMode = false,
  sessionId,
  onOpenSettings,
  modelControls = null,
}: Pick<ModelProps, 'sessionId' | 'onOpenSettings'> & {
  /** The model picker and gauge the card's bottom row carries right after
   *  the + (a phone's coding composer); null leaves them on the line below. */
  modelControls?: ReactNode;
  /** Agent mode: no model or effort controls (the agent's profile sets them);
   *  the + menu keeps attachments and, in a room, "Call an agent". */
  agentMode?: boolean;
  attachAccept: string;
  fileInput: RefObject<HTMLInputElement | null>;
  onFilesChosen: (files: FileList) => void;
  textarea: RefObject<HTMLTextAreaElement | null>;
  paletteAnchor: RefObject<HTMLFormElement | null>;
  recoveryScope: string;
  /** A new-task draft's selected Project: its skills are read for it. */
  projectScope: string;
  goalDialogOpen: boolean;
  setGoalDialogOpen: (open: boolean) => void;
  /** Bumped by /skills to open the add menu. */
  addMenuRequest: number;
  /** A group room's members: the add menu offers "Call an agent". */
  roomMembers?: RoomMemberLabel[] | null;
  onAskMember?: (agentId: string) => void;
  goalDisabled: boolean;
  executeSlash: (command: string) => Promise<boolean>;
  transitioning: boolean;
  paneActive: boolean;
  hasConversation: boolean;
  submitting: boolean;
  skillSelection: ReturnType<typeof useComposerSkill>;
  mention: ReturnType<typeof useComposerPalettes>['mention'];
  dictation: ReturnType<typeof useComposerDictation>;
  stopOnly: boolean;
  voiceSend: boolean;
  /** The draft or attachments hold something to send, or visualize pins or
   *  picks are queued. The footer takes this derived flag, never the draft,
   *  so typing does not re-render the controls it carries. */
  sendable: boolean;
  onStop: () => void;
}) {
  // The memoized controls below get fixed callback identities that run the
  // latest props, so a keystroke's re-render of this row skips them.
  const attach = useStableCallback(() => fileInput.current?.click());
  const pickSkill = useStableCallback((name: string) => {
    skillSelection.select(name);
    mention.setDismissed(mention.signature);
    queueMicrotask(() => textarea.current?.focus());
  });
  const askMember = useStableCallback((agentId: string) => onAskMember?.(agentId));
  const runSlash = useStableCallback((command: string) => executeSlash(command));
  const openSkillSettings = useStableCallback(() => onOpenSettings('skills'));
  const stop = useStableCallback(() => onStop());
  const stopDictationAndSend = useStableCallback(() => void dictation.stopDictationAndSend());
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
        projectPath={projectScope}
        disabled={transitioning || !paneActive}
        goalDisabled={goalDisabled}
        openRequest={addMenuRequest}
        roomMembers={roomMembers}
        onAskMember={onAskMember && askMember}
        onAttach={attach}
        onSkill={pickSkill}
        onGoal={runSlash}
        onMore={openSkillSettings}
        simple={agentMode}
      />
      {modelControls}
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
          transitioning={transitioning}
          hasConversation={hasConversation}
          dictationState={dictation.dictationState}
          sendable={sendable}
          onStop={stop}
          onStopDictationAndSend={stopDictationAndSend}
        />
      </span>
    </div>
  );
}
