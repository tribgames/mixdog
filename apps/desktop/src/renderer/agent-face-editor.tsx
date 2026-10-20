// An agent's face controls, shared by the new-agent dialog and the agent
// profile: the 마스코트 / 내 이미지 segmented control, then either the mascot
// picker or one upload row per motion state. An upload is prepared here
// (agent-avatar-image.ts); the caller keeps the draft.
import { useRef, useState } from 'react';
import {
  AGENT_AVATAR_STATES,
  type AgentAvatarState,
  type AgentAvatarValue,
} from '../../../../src/runtime/shared/agent-avatar.mjs';
import {
  AgentAvatarPicker,
  AgentImageAvatar,
  type AvatarImage,
  type AvatarImages,
  customAvatarSource,
  type MascotAvatarValue,
} from './agent-avatar';
import {
  AGENT_AVATAR_IMAGE_TYPES,
  type AvatarStateUpload,
  agentAvatarFileProblem,
  prepareAgentAvatarImage,
} from './agent-avatar-image';
import { useAvatarMotion, useReducedMotion } from './avatar-motion';
import type { RecordValue } from './desktop-types';
import { ErrorNotice, errorMessageText } from './ErrorNotice';
import { t } from './i18n';

export function AgentAvatarSegments({
  custom,
  disabled,
  onKind,
}: {
  custom: boolean;
  disabled: boolean;
  onKind(kind: 'mascot' | 'image'): void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a two-button segmented control, not a form fieldset
    <div className="agent-create-segments" role="group" aria-label={t('Avatar')}>
      <button type="button" aria-pressed={!custom} disabled={disabled} onClick={() => onKind('mascot')}>
        {t('Mascot')}
      </button>
      <button type="button" aria-pressed={custom} disabled={disabled} onClick={() => onKind('image')}>
        {t('My image')}
      </button>
    </div>
  );
}

/** One state's image in an editor: a saved file, or a new upload. */
export type AvatarStateDraft = { file: string } | AvatarStateUpload;
export type AvatarStatesDraft = Partial<Record<AgentAvatarState, AvatarStateDraft>>;

/** A saved custom avatar as a draft (nothing for a mascot). */
export function customAvatarDraft(avatar: AgentAvatarValue): AvatarStatesDraft {
  if (avatar.kind !== 'custom') return {};
  return Object.fromEntries(Object.entries(avatar.states).map(([state, file]) => [state, { file }]));
}

/** A draft as the avatar to save: kept files by name, uploads as data. */
export function customAvatarPayload(draft: AvatarStatesDraft): RecordValue {
  return {
    kind: 'custom',
    states: Object.fromEntries(
      Object.entries(draft).map(([state, entry]) => [state, entry && 'file' in entry ? entry.file : entry])
    ),
  };
}

/** A draft state's image, falling back to idle's. */
export function draftImage(
  draft: AvatarStatesDraft,
  images: AvatarImages,
  state: AgentAvatarState
): AvatarImage | undefined {
  const entry = draft[state] ?? draft.idle;
  if (!entry) return undefined;
  return 'file' in entry ? images[entry.file] : { url: entry.data, poster: entry.poster ?? '' };
}

/** The editor's big preview of a draft state: it moves (it holds the stage
 *  while shown), or its first frame under reduced motion. */
export function AvatarDraftPreview({
  draft,
  images,
  state,
  className,
}: {
  draft: AvatarStatesDraft;
  images: AvatarImages;
  state: AgentAvatarState;
  className?: string;
}) {
  const element = useRef<Element | null>(null);
  const shown = useAvatarMotion(state, element, 5);
  const reduced = useReducedMotion();
  const src = customAvatarSource((motion) => draftImage(draft, images, motion), state, shown, reduced);
  if (!src) return null;
  return (
    <AgentImageAvatar
      ref={(node) => {
        element.current = node;
      }}
      src={src}
      className={className}
      state={shown}
    />
  );
}

const STATE_LABELS: Record<AgentAvatarState, () => string> = {
  idle: () => t('Default state'),
  typing: () => t('Typing'),
  message: () => t('New message'),
};

/** One state's row: its still thumbnail (a click previews it above), its
 *  name and fallback, upload (also by dropping a file) and reset. */
function AvatarStateRow({
  state,
  draft,
  saved,
  images,
  selected,
  disabled,
  onPick,
  onReset,
  onRemove,
  onPreview,
}: {
  state: AgentAvatarState;
  draft: AvatarStatesDraft;
  saved: AvatarStatesDraft;
  images: AvatarImages;
  selected: boolean;
  disabled: boolean;
  onPick(file: File | undefined): void;
  onReset(): void;
  onRemove(): void;
  onPreview(): void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const own = draft[state];
  const image = draftImage(draft, images, state);
  const label = STATE_LABELS[state]();
  // Idle only goes back to its saved image; the others back to idle's.
  const resettable = Boolean(own && own !== saved.idle && saved.idle);
  return (
    <li
      className="agent-avatar-state"
      data-state={state}
      data-selected={selected ? 'true' : undefined}
      data-dragging={dragging ? 'true' : undefined}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (!disabled) onPick(event.dataTransfer.files[0]);
      }}
    >
      <button
        type="button"
        className="agent-avatar-state-thumb"
        aria-pressed={selected}
        aria-label={t('Preview {{state}}', { state: label })}
        data-fallback={image && !own ? 'true' : undefined}
        disabled={!image}
        onClick={onPreview}
      >
        {image ? <img src={image.poster || image.url} alt="" draggable={false} /> : null}
      </button>
      <span className="agent-avatar-state-text">
        <b>{label}</b>
        {state === 'idle' && <small>{t('Required')}</small>}
      </span>
      <button type="button" disabled={disabled} onClick={() => fileInput.current?.click()}>
        {own ? t('Change') : t('Upload')}
      </button>
      {resettable && state === 'idle' && (
        <button type="button" disabled={disabled} onClick={onReset}>
          {t('Reset')}
        </button>
      )}
      {own && (
        <button type="button" disabled={disabled} onClick={onRemove}>
          {t('Remove')}
        </button>
      )}
      <input
        ref={fileInput}
        type="file"
        hidden
        accept={AGENT_AVATAR_IMAGE_TYPES.join(',')}
        aria-label={t('{{state}} image', { state: label })}
        onChange={(event) => {
          onPick(event.currentTarget.files?.[0]);
          event.currentTarget.value = '';
        }}
      />
    </li>
  );
}

/** 내 이미지: one row per motion state (idle required, the rest fall back to
 *  it), the states still to come, the format help and the starter kit. */
function AvatarStatesEditor({
  draft,
  saved,
  images,
  disabled,
  prepare,
  previewState,
  onPreviewState,
  onDraft,
  onKind,
}: {
  draft: AvatarStatesDraft;
  saved: AvatarStatesDraft;
  images: AvatarImages;
  disabled: boolean;
  prepare(file: File): Promise<AvatarStateUpload>;
  previewState: AgentAvatarState;
  onPreviewState(state: AgentAvatarState): void;
  onDraft(next: AvatarStatesDraft): void;
  onKind(kind: 'mascot' | 'image'): void;
}) {
  const [error, setError] = useState('');
  const pick = async (state: AgentAvatarState, file: File | undefined) => {
    if (!file) return;
    const problem = agentAvatarFileProblem(file);
    setError(problem);
    if (problem) return;
    try {
      const upload = await prepare(file);
      onDraft({ ...draft, [state]: upload });
      onPreviewState(state);
    } catch (reason) {
      setError(errorMessageText(reason));
    }
  };
  const reset = (state: AgentAvatarState) => {
    const next = { ...draft };
    if (state === 'idle' && saved.idle) next.idle = saved.idle;
    else delete next[state];
    onDraft(next);
  };
  // Removing the base image drops every state image and returns to 마스코트.
  const remove = (state: AgentAvatarState) => {
    if (state === 'idle') {
      onDraft({});
      onPreviewState('idle');
      onKind('mascot');
      return;
    }
    const next = { ...draft };
    delete next[state];
    onDraft(next);
  };
  return (
    <div className="agent-avatar-states">
      <ul>
        {AGENT_AVATAR_STATES.map((state) => (
          <AvatarStateRow
            key={state}
            state={state}
            draft={draft}
            saved={saved}
            images={images}
            selected={previewState === state}
            disabled={disabled}
            onPick={(file) => void pick(state, file)}
            onReset={() => reset(state)}
            onRemove={() => remove(state)}
            onPreview={() => onPreviewState(state)}
          />
        ))}
      </ul>
      <p className="agent-avatar-states-help">
        {t('Square PNG or JPG pictures and GIF, APNG or WebP animations are supported (1 MB, up to 512px).')}
      </p>
      {error && <ErrorNotice error={error} />}
    </div>
  );
}

export function AgentAvatarChooser({
  custom,
  avatar,
  signature,
  disabled,
  prepare = prepareAgentAvatarImage,
  draft,
  saved = NO_DRAFT,
  images = NO_IMAGES,
  previewState,
  onPreviewState,
  onAvatar,
  onDraft,
  onKind,
}: {
  custom: boolean;
  avatar: MascotAvatarValue;
  /** Mixy: its own default look, offered as 기본 Mixy 모습. */
  signature?: MascotAvatarValue;
  disabled: boolean;
  /** Turns a picked file into the upload to save (tests stub it). */
  prepare?(file: File): Promise<AvatarStateUpload>;
  draft: AvatarStatesDraft;
  saved?: AvatarStatesDraft;
  images?: AvatarImages;
  previewState: AgentAvatarState;
  onPreviewState(state: AgentAvatarState): void;
  onAvatar(next: MascotAvatarValue): void;
  onDraft(next: AvatarStatesDraft): void;
  onKind(kind: 'mascot' | 'image'): void;
}) {
  if (custom) {
    return (
      <AvatarStatesEditor
        draft={draft}
        saved={saved}
        images={images}
        disabled={disabled}
        prepare={prepare}
        previewState={previewState}
        onPreviewState={onPreviewState}
        onDraft={onDraft}
        onKind={onKind}
      />
    );
  }
  return <AgentAvatarPicker value={avatar} signature={signature} disabled={disabled} onChange={onAvatar} />;
}

const NO_DRAFT: AvatarStatesDraft = {};
const NO_IMAGES: AvatarImages = {};
