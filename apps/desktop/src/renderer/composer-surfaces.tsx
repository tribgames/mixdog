// Presentational pieces of the composer: the three palettes, attachment
// chips, the dictation overlay and the mic/send discs. State stays in the
// composer hooks; these only paint what they are handed.
import { ArrowUp, Mic, X } from 'lucide-react';
import React, { useEffect, useRef, type CSSProperties, type MutableRefObject, type RefObject } from 'react';
import { composerAttachmentSource } from './attachment-menu';
import { AttachmentCard, composerCardKind, composerCardMeta } from './attachment-card';
import { openAttachmentSource, useAttachmentContextMenu, type AttachmentOpenFile } from './attachment-context-menu';
import { CapabilityIcon } from './CapabilityIcon';
import type { SkillMentionResult } from './composer-skill-mentions';
import type { ComposerAttachment } from './composer-support';
import { ComposerPalette } from './ComposerPalette';
import { t } from './i18n';
import { attachmentSummary, textWithoutAttachmentTokens } from './message-attachment-summary';
import { MxIcon } from './MxIcon';
import { ProgressSpinner } from './ProgressSpinner';
import { type desktopComposerSlashCommands, desktopSlashCommandDescription } from './slash-commands';
import { oneLine } from './text-format';
import type { DictationState } from './use-composer-dictation';

type Anchor = RefObject<HTMLFormElement | null>;
type Panel = RefObject<HTMLDivElement | null>;

export function composerPlaceholder({
  hasConversation,
  fallback,
}: {
  hasConversation: boolean;
  fallback: string;
}): string {
  // User request: one stable placeholder — no rotating variants — and once a
  // session has content the composer shows NO hint copy at all; instructional
  // placeholders belong to the empty new-task state. A message sent while a
  // turn runs is an ordinary send, so the turn changes nothing here.
  if (hasConversation) return '';
  return t(fallback);
}

/** A message's first non-empty line. */
function firstLinePreview(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || '[Attachment]'
  );
}

function preventFocusSteal(event: React.MouseEvent) {
  event.preventDefault();
}

export function MessageSelectorPalette({
  anchor,
  panel,
  messages,
  index,
  setIndex,
  onSelect,
}: {
  anchor: Anchor;
  panel: Panel;
  messages: Array<{ id: string; text: string }>;
  index: number;
  setIndex: (index: number) => void;
  onSelect: (id: string) => void;
}) {
  return (
    <ComposerPalette
      anchor={anchor}
      panel={panel}
      id="composer-message-selector"
      className="message-selector"
      label={t('Previous messages')}
    >
      <header>
        <span>{t('Jump back to a message')}</span>
      </header>
      {messages.map((message, rowIndex) => (
        <button
          type="button"
          role="option"
          aria-selected={rowIndex === index}
          key={message.id}
          id={`composer-message-option-${rowIndex}`}
          title={message.text}
          onMouseDown={preventFocusSteal}
          onMouseEnter={() => setIndex(rowIndex)}
          onClick={() => onSelect(message.id)}
        >
          {attachmentSummary(message.text) && (
            <small className="message-applied-skill">{attachmentSummary(message.text)}</small>
          )}
          <span>{oneLine(firstLinePreview(textWithoutAttachmentTokens(message.text)), 90)}</span>
        </button>
      ))}
    </ComposerPalette>
  );
}

export function SlashPalette({
  anchor,
  panel,
  commands,
  index,
  setIndex,
  onSelect,
}: {
  anchor: Anchor;
  panel: Panel;
  commands: ReturnType<typeof desktopComposerSlashCommands>;
  index: number;
  setIndex: (index: number) => void;
  onSelect: (usage: string) => void;
}) {
  return (
    <ComposerPalette anchor={anchor} panel={panel} id="composer-slash-palette" label={t('Slash commands')}>
      <header>
        <span>{t('Commands')}</span>
      </header>
      {commands.map((command, rowIndex) => (
        <button
          type="button"
          role="option"
          aria-selected={rowIndex === index}
          key={command.name}
          id={`composer-slash-option-${rowIndex}`}
          onMouseDown={preventFocusSteal}
          onMouseEnter={() => setIndex(rowIndex)}
          onClick={() => onSelect(command.usage)}
        >
          <code>{command.usage}</code>
          <span>{desktopSlashCommandDescription(command)}</span>
        </button>
      ))}
    </ComposerPalette>
  );
}

function splitMentionPath(path: string): { directory: string; filename: string } {
  // Folder rows end in `/`; the folder's own name is the bold part.
  const separator = path.lastIndexOf('/', path.length - 2);
  if (separator < 0) return { directory: '', filename: path };
  return { directory: path.slice(0, separator + 1), filename: path.slice(separator + 1) };
}

export function MentionPalette({
  anchor,
  panel,
  results,
  loading,
  index,
  setIndex,
  onSelect,
}: {
  anchor: Anchor;
  panel: Panel;
  results: string[];
  loading: boolean;
  index: number;
  setIndex: (index: number) => void;
  onSelect: (path: string) => void;
}) {
  return (
    <ComposerPalette
      anchor={anchor}
      panel={panel}
      id="composer-mention-palette"
      className="mention-palette"
      label={t('Project files')}
    >
      <header>
        <MxIcon name="open-file" size={14} />
        <span>{t('Files')}</span>
      </header>
      {results.map((path, rowIndex) => {
        const { directory, filename } = splitMentionPath(path);
        return (
          <button
            type="button"
            role="option"
            aria-selected={rowIndex === index}
            key={path}
            id={`composer-mention-option-${rowIndex}`}
            title={path}
            onMouseDown={preventFocusSteal}
            onMouseEnter={() => setIndex(rowIndex)}
            onClick={() => onSelect(path)}
          >
            <MxIcon name={path.endsWith('/') ? 'folder' : 'open-file'} size={14} />
            <span className="mention-path">
              <span>{directory}</span>
              <strong>{filename}</strong>
            </span>
          </button>
        );
      })}
      {results.length === 0 && <p role="status">{loading ? t('Searching project files…') : t('No matching files.')}</p>}
    </ComposerPalette>
  );
}

/** `$` palette, built like the `@` file palette: the user's enabled custom
 *  skills. Built-ins are recognised when typed in full but not listed. */
export function SkillMentionPalette({
  anchor,
  panel,
  results,
  available,
  query,
  index,
  setIndex,
  onSelect,
  onOpenSkillSettings,
}: {
  anchor: Anchor;
  panel: Panel;
  results: SkillMentionResult[];
  /** Whether the user has any enabled custom skill at all. */
  available: boolean;
  query: string;
  index: number;
  setIndex: (index: number) => void;
  onSelect: (name: string) => void;
  /** Settings › Skills, the same destination as the + menu's manage entry. */
  onOpenSkillSettings: () => void;
}) {
  return (
    <ComposerPalette
      anchor={anchor}
      panel={panel}
      id="composer-skill-mention-palette"
      className="mention-palette skill-mention-palette"
      label={t('Skills')}
    >
      <header>
        <CapabilityIcon name="skill" size={14} />
        <span>{t('Skills')}</span>
      </header>
      {results.map(({ skill, start }, rowIndex) => (
        <button
          type="button"
          role="option"
          aria-selected={rowIndex === index}
          key={skill.name}
          id={`composer-skill-mention-option-${rowIndex}`}
          title={skill.description ? `$${skill.name} — ${skill.description}` : `$${skill.name}`}
          onMouseDown={preventFocusSteal}
          onMouseEnter={() => setIndex(rowIndex)}
          onClick={() => onSelect(skill.name)}
        >
          <CapabilityIcon name={skill.name} size={14} />
          <span className="skill-mention-name">
            <span className="skill-mention-sigil">$</span>
            {skill.name.slice(0, start)}
            {query ? <b>{skill.name.slice(start, start + query.length)}</b> : null}
            {skill.name.slice(start + query.length)}
          </span>
          <span className="skill-mention-description">{skill.description}</span>
        </button>
      ))}
      {results.length === 0 && available && (
        <p className="skill-mention-empty" role="status">
          {t('No matching skills.')}
        </p>
      )}
      {!available && (
        <p className="skill-mention-empty" role="status">
          {t('No skills are on.')}{' '}
          <button
            type="button"
            className="skill-mention-settings"
            onMouseDown={preventFocusSteal}
            onClick={onOpenSkillSettings}
          >
            {t('Open skill settings')}
          </button>
        </p>
      )}
    </ComposerPalette>
  );
}

export function AttachmentChips({
  attachments,
  onRemove,
  onEdit,
  onError,
  onOpenFile,
}: {
  /** Same editor-pane opener the transcript's file links use. */
  onOpenFile?: AttachmentOpenFile;
  attachments: ComposerAttachment[];
  onRemove: (attachment: ComposerAttachment) => void;
  /** Opens the editor for a folded paste chip. */
  onEdit: (attachment: ComposerAttachment) => void;
  onError: (message: string) => void;
}) {
  const { menuProps, menuElement } = useAttachmentContextMenu(onOpenFile);
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the chip list container keeps its tag; the label names the attachments
    <div className="composer-attachments" aria-label={t('Attachments')}>
      {menuElement}
      {attachments.map((attachment) => {
        const editable = attachment.kind === 'text' && attachment.source === 'paste';
        const image = attachment.kind === 'image';
        return (
          <AttachmentCard
            key={attachment.id}
            kind={composerCardKind(attachment)}
            name={attachment.name}
            imageUrl={image ? `data:${attachment.mimeType};base64,${attachment.data}` : undefined}
            content={image ? undefined : attachment.data}
            meta={composerCardMeta(attachment)}
            menu={menuProps(composerAttachmentSource(attachment))}
            onOpen={
              image
                ? () => {
                    onError('');
                    openAttachmentSource(composerAttachmentSource(attachment), onOpenFile);
                  }
                : undefined
            }
            onEdit={editable ? () => onEdit(attachment) : undefined}
            onRemove={() => onRemove(attachment)}
          />
        );
      })}
    </div>
  );
}

// The recording overlay renders m:ss over the typing surface. The placeholder
// cannot carry this signal: it is blank once a session has content.
function formatDictationElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// Envelope of the level meter: one shared level, five bars, tallest in the
// middle so the row reads as a voice instead of a progress bar.
const DICTATION_BAR_GAINS = [0.42, 0.72, 1, 0.78, 0.5];

// The meter owns its own animation frame and writes ONLY a CSS variable, so a
// live 60fps level never re-renders the composer around it.
function DictationMeter({ levelRef }: { levelRef: MutableRefObject<number> }) {
  const host = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let frame = window.requestAnimationFrame(function paint() {
      host.current?.style.setProperty('--mx-dictation-level', levelRef.current.toFixed(3));
      frame = window.requestAnimationFrame(paint);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [levelRef]);
  return (
    <span className="composer-dictation-meter" ref={host} aria-hidden="true">
      {DICTATION_BAR_GAINS.map((gain, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed meter bars are positional and never reorder
        <span key={index} style={{ '--mx-dictation-gain': gain } as CSSProperties} />
      ))}
    </span>
  );
}

function DictationProgress() {
  return (
    <span className="composer-dictation-progress" aria-hidden="true">
      {DICTATION_BAR_GAINS.map((_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed progress bars are positional and never reorder
        <span key={index} />
      ))}
    </span>
  );
}

// Recording takes over the typing surface, never the footer: the stop and
// send discs stay reachable, and the draft underneath is untouched until the
// transcript is appended to it.
export function DictationOverlay({
  state,
  levelRef,
  elapsedMs,
  onCancel,
}: {
  state: DictationState;
  levelRef: MutableRefObject<number>;
  elapsedMs: number;
  onCancel: () => void;
}) {
  return (
    <div className="composer-dictation-overlay" data-state={state}>
      <div className="composer-dictation-status" data-state={state}>
        {state === 'preparing' && (
          <>
            {/* No meter and no timer yet: nothing is being captured, so the
                user waits for the bars before speaking. */}
            <Mic className="composer-dictation-preparing" size={16} aria-hidden="true" />
            <span className="composer-dictation-elapsed" role="status">
              {t('Starting microphone…')}
            </span>
            <button
              type="button"
              className="composer-dictation-cancel"
              aria-label={t('Discard recording')}
              data-tooltip={t('Discard · Esc')}
              data-tooltip-side="top"
              onClick={onCancel}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </>
        )}
        {state === 'recording' && (
          <>
            <DictationMeter levelRef={levelRef} />
            {/* No live region on the timer: a polite announcement twice a second
                would talk over everything else. The mic button's label carries
                the state instead. */}
            <span className="composer-dictation-elapsed">{formatDictationElapsed(elapsedMs)}</span>
            <button
              type="button"
              className="composer-dictation-cancel"
              aria-label={t('Discard recording')}
              data-tooltip={t('Discard · Esc')}
              data-tooltip-side="top"
              onClick={onCancel}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </>
        )}
        {state === 'transcribing' && (
          <>
            <DictationProgress />
            <span className="composer-dictation-elapsed" role="status">
              {t('Transcribing…')}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

// Recording swaps the glyph for the stop square: the disc alone never said
// that pressing it ENDS the take.
export function DictationButton({
  state,
  disabled,
  onToggle,
}: {
  state: DictationState;
  disabled: boolean;
  onToggle: () => void;
}) {
  let tooltip = t('Dictate');
  if (state === 'recording') tooltip = t('Stop and transcribe · Enter');
  else if (state === 'preparing') tooltip = t('Starting microphone…');
  else if (state === 'transcribing') tooltip = t('Transcribing…');
  let glyph = <Mic size={16} />;
  if (state === 'transcribing') glyph = <ProgressSpinner className="composer-mic-spinner" size={16} />;
  else if (state === 'recording') glyph = <MxIcon name="stop" size={16} />;
  return (
    <button
      type="button"
      className={`composer-tool composer-mic ${state !== 'idle' ? `is-${state}` : ''}`.trim()}
      disabled={disabled}
      aria-label={state === 'recording' || state === 'preparing' ? t('Stop dictation') : t('Dictate with voice')}
      aria-pressed={state === 'recording' || state === 'preparing'}
      data-tooltip={tooltip}
      data-tooltip-side="top"
      onClick={onToggle}
    >
      {glyph}
    </button>
  );
}

// Mid-take the disc ENDS the take and sends what was spoken, instead of
// sitting disabled: the transcript still only reaches the draft after the
// recorder stops, so this press chains stop → transcribe → submit.
// Transcribing keeps it disabled — that take is already on its way.
export const SendButton = React.memo(function SendButton({
  stopOnly,
  voiceSend,
  submitting,
  transitioning,
  hasConversation,
  dictationState,
  sendable,
  onStop,
  onStopDictationAndSend,
}: {
  stopOnly: boolean;
  voiceSend: boolean;
  submitting: boolean;
  transitioning: boolean;
  hasConversation: boolean;
  dictationState: DictationState;
  /** The draft or attachments hold something to send, or visualize pins or
   *  picks are queued. Derived by the composer so typing re-renders this
   *  button only when sendability flips. */
  sendable: boolean;
  onStop: () => void;
  onStopDictationAndSend: () => void;
}) {
  let onClick: (() => void) | undefined;
  if (stopOnly) onClick = onStop;
  else if (voiceSend) onClick = onStopDictationAndSend;
  const disabled = !stopOnly && !voiceSend && (!sendable || transitioning || dictationState !== 'idle');
  let label = t('Send message');
  if (stopOnly) label = t('Stop generation');
  else if (voiceSend) label = t('Stop dictation and send');
  else if (submitting) label = hasConversation ? t('Sending message') : t('Starting session');
  let tooltip = t('Send · Enter');
  if (stopOnly) tooltip = t('Stop');
  else if (voiceSend) tooltip = t('Stop and send');
  let glyph = <ArrowUp size={16} />;
  if (stopOnly) glyph = <MxIcon name="stop" size={16} />;
  else if (submitting) glyph = <ProgressSpinner className="composer-mic-spinner" size={16} />;
  return (
    <button
      type={stopOnly || voiceSend ? 'button' : 'submit'}
      className={`send-button${stopOnly ? ' stop' : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      data-tooltip={tooltip}
      data-tooltip-side="top"
    >
      {glyph}
    </button>
  );
});
