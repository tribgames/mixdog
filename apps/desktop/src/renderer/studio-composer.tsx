import { ArrowUp, Plus, X } from 'lucide-react';
import { type Dispatch, type DragEvent, type RefObject, type SetStateAction, useRef, useState } from 'react';

import { t } from './i18n';
import { StudioRouteMenu, type StudioModelEntry, type StudioOptionRow, type StudioSliderRow } from './StudioRouteMenu';
import type { StudioReference } from './studio-media-state';
import { StudioBoardPicker } from './studio-board-components';
import type { StudioBoard } from './studio-boards';
import type { MediaKind } from './studio-support';

type ReferenceDrop = {
  source: number;
  target: number;
  position: 'before' | 'after';
};

/** Which side of the hovered reference chip the dragged one lands on. */
function dropPosition(event: DragEvent<HTMLElement>): ReferenceDrop['position'] {
  const bounds = event.currentTarget.getBoundingClientRect();
  return event.clientX < bounds.left + bounds.width / 2 ? 'before' : 'after';
}

/** Drag-to-reorder for the reference chips. `justEnded` is true for the tick
 *  after a drag, so the click that ends it does not also open the image. */
function useReferenceReorder(count: number, onChange: Dispatch<SetStateAction<StudioReference[]>>) {
  const dragged = useRef<number | null>(null);
  const justEnded = useRef(false);
  const [referenceDrop, setReferenceDrop] = useState<ReferenceDrop | null>(null);
  const finish = () => {
    dragged.current = null;
    setReferenceDrop(null);
    window.setTimeout(() => {
      justEnded.current = false;
    }, 0);
  };
  return {
    referenceDrop,
    justEnded: () => justEnded.current,
    onDragStart: (event: DragEvent<HTMLElement>, index: number) => {
      if ((event.target as HTMLElement).closest('.studio-ref-remove')) {
        event.preventDefault();
        return;
      }
      dragged.current = index;
      justEnded.current = false;
      setReferenceDrop({ source: index, target: index, position: 'before' });
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
    },
    onDragOver: (event: DragEvent<HTMLElement>, index: number) => {
      const source = dragged.current;
      if (source === null || source === index) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setReferenceDrop({ source, target: index, position: dropPosition(event) });
    },
    onDrop: (event: DragEvent<HTMLElement>, index: number) => {
      event.preventDefault();
      const source = dragged.current ?? Number(event.dataTransfer.getData('text/plain'));
      const position = dropPosition(event);
      if (Number.isInteger(source) && source >= 0 && source < count && source !== index) {
        onChange((current) => {
          if (source >= current.length || index >= current.length) return current;
          const next = [...current];
          const [moved] = next.splice(source, 1);
          const target = index - (source < index ? 1 : 0);
          next.splice(target + (position === 'after' ? 1 : 0), 0, moved);
          return next;
        });
      }
      justEnded.current = true;
      finish();
    },
    onDragEnd: () => {
      justEnded.current = true;
      finish();
    },
  };
}

function StudioReferenceChips({
  references,
  onOpenReference,
  onReferencesChange,
}: {
  references: StudioReference[];
  onOpenReference: (reference: StudioReference, index: number) => Promise<void>;
  onReferencesChange: Dispatch<SetStateAction<StudioReference[]>>;
}) {
  const { referenceDrop, ...dragHandlers } = useReferenceReorder(references.length, onReferencesChange);
  if (references.length === 0) return null;
  // Keyed by content, so a reorder moves each chip instead of repainting
  // another image into it; a repeated image counts its earlier copies.
  const seenReferences = new Map<string, number>();
  const referenceKeys = references.map((reference) => {
    const copies = seenReferences.get(reference.url) ?? 0;
    seenReferences.set(reference.url, copies + 1);
    return copies ? `${reference.url}#${copies}` : reference.url;
  });
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: label names the reference group without adding a role, which would change screen-reader semantics
    <div className="studio-refs" aria-label={t('Reference images')}>
      {references.map((reference, index) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop reordering surface; the remove control inside is the keyboard path
        <span
          key={referenceKeys[index]}
          className="studio-ref"
          draggable
          data-dragging={referenceDrop?.source === index ? 'true' : undefined}
          data-drop-position={
            referenceDrop?.target === index && referenceDrop.source !== index ? referenceDrop.position : undefined
          }
          onDragStart={(event) => dragHandlers.onDragStart(event, index)}
          onDragOver={(event) => dragHandlers.onDragOver(event, index)}
          onDrop={(event) => dragHandlers.onDrop(event, index)}
          onDragEnd={dragHandlers.onDragEnd}
        >
          <button
            type="button"
            className="studio-ref-open"
            aria-label={`${t('Open image')} ${index + 1}`}
            onClick={() => {
              if (!dragHandlers.justEnded()) void onOpenReference(reference, index);
            }}
          >
            <img src={reference.url} alt="" draggable={false} />
          </button>
          <button
            type="button"
            className="studio-ref-remove"
            aria-label={t('Remove reference')}
            onClick={() => onReferencesChange((current) => current.filter((_, at) => at !== index))}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </span>
      ))}
    </div>
  );
}

export function StudioComposer({
  boardId,
  boards,
  dropping,
  kind,
  lane,
  maxReferences,
  model,
  modelEntries,
  prompt,
  promptRef,
  references,
  routeRows,
  slider,
  onFiles,
  onGenerate,
  onOpenReference,
  onPromptChange,
  onReferencesChange,
  onSelectBoard,
  onSelectModel,
}: {
  /** The board new runs join ('' = none). */
  boardId: string;
  boards: readonly StudioBoard[];
  dropping: boolean;
  kind: MediaKind;
  lane: string;
  maxReferences: number;
  model: string;
  modelEntries: StudioModelEntry[];
  prompt: string;
  promptRef: RefObject<HTMLTextAreaElement | null>;
  references: StudioReference[];
  routeRows: StudioOptionRow[];
  slider: StudioSliderRow | null;
  onFiles: (files: FileList | File[]) => Promise<void>;
  onGenerate: () => void;
  onOpenReference: (reference: StudioReference, index: number) => Promise<void>;
  onPromptChange: (prompt: string) => void;
  onReferencesChange: Dispatch<SetStateAction<StudioReference[]>>;
  onSelectBoard: (boardId: string) => void;
  onSelectModel: (entry: StudioModelEntry) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <>
      <div className="studio-composer" data-dropping={dropping ? 'true' : undefined}>
        <StudioReferenceChips
          references={references}
          onOpenReference={onOpenReference}
          onReferencesChange={onReferencesChange}
        />
        <div className="studio-composer-bar">
          <button
            type="button"
            className="composer-tool studio-attach"
            aria-label={t('Attach reference image')}
            disabled={references.length >= maxReferences}
            data-tooltip={t('Attach reference')}
            onClick={() => fileInput.current?.click()}
          >
            <Plus size={16} aria-hidden="true" />
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => {
              if (event.currentTarget.files) void onFiles(event.currentTarget.files);
              event.currentTarget.value = '';
            }}
          />
          <textarea
            value={prompt}
            rows={1}
            ref={promptRef}
            aria-label={t('Generation prompt')}
            placeholder={kind === 'video' ? t('Describe the video…') : t('Describe the image you want…')}
            onChange={(event) => onPromptChange(event.currentTarget.value)}
            onPaste={(event) => {
              const files = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'));
              if (files.length) void onFiles(files);
            }}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter breaks the line — same grammar as the
              // session composer.
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              onGenerate();
            }}
          />
          {/* Never flips to a disabled spinner: each press queues another run
          and the in-flight ones report on their own tiles. */}
          <button
            type="button"
            className="send-button"
            aria-label={t('Generate')}
            data-tooltip={t('Generate')}
            disabled={!lane || !prompt.trim()}
            onClick={onGenerate}
          >
            <ArrowUp size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      {/* Like the chat composer's footer, a slim line under the card: the
      board new runs join on the left, the model on the right. The model
      picker stays mounted across kind switches (the model is already valid
      for this render); the line scrolls sideways instead of clipping on a phone. */}
      <div className="studio-composer-controls">
        <StudioBoardPicker boards={boards} openId={boardId} onSelect={onSelectBoard} />
        <span className="studio-composer-controls-gap" aria-hidden="true" />
        <StudioRouteMenu
          entries={modelEntries}
          lane={lane}
          model={model}
          rows={routeRows}
          slider={slider}
          onSelect={onSelectModel}
        />
      </div>
    </>
  );
}
