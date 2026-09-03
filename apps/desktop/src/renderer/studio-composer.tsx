import { Plus, Sparkles, X } from 'lucide-react';
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useRef,
  useState,
} from 'react';

import { t } from './i18n';
import {
  StudioRouteMenu,
  type StudioModelEntry,
  type StudioOptionRow,
  type StudioSliderRow,
} from './StudioRouteMenu';
import type { StudioReference } from './studio-media-state';
import type { MediaKind } from './studio-support';

type ReferenceDrop = {
  source: number;
  target: number;
  position: 'before' | 'after';
};

export function StudioComposer({
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
  onSelectModel,
}: {
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
  onSelectModel: (entry: StudioModelEntry) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const draggedReferenceIndex = useRef<number | null>(null);
  const referenceDragJustEnded = useRef(false);
  const [referenceDrop, setReferenceDrop] = useState<ReferenceDrop | null>(null);

  const finishReferenceDrag = () => {
    draggedReferenceIndex.current = null;
    setReferenceDrop(null);
    window.setTimeout(() => { referenceDragJustEnded.current = false; }, 0);
  };

  return <div className="studio-composer" data-dropping={dropping ? 'true' : undefined}>
    {references.length > 0 && <div className="studio-refs" aria-label={t('Reference images')}>
      {references.map((reference, index) => <span key={`${reference.url}-${index}`} className="studio-ref"
        draggable
        data-dragging={referenceDrop?.source === index ? 'true' : undefined}
        data-drop-position={referenceDrop?.target === index && referenceDrop.source !== index
          ? referenceDrop.position : undefined}
        onDragStart={(event) => {
          if ((event.target as HTMLElement).closest('.studio-ref-remove')) {
            event.preventDefault();
            return;
          }
          draggedReferenceIndex.current = index;
          referenceDragJustEnded.current = false;
          setReferenceDrop({ source: index, target: index, position: 'before' });
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', String(index));
        }}
        onDragOver={(event) => {
          const source = draggedReferenceIndex.current;
          if (source === null || source === index) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          const bounds = event.currentTarget.getBoundingClientRect();
          const position = event.clientX < bounds.left + bounds.width / 2 ? 'before' : 'after';
          setReferenceDrop({ source, target: index, position });
        }}
        onDrop={(event) => {
          event.preventDefault();
          const source = draggedReferenceIndex.current
            ?? Number(event.dataTransfer.getData('text/plain'));
          const bounds = event.currentTarget.getBoundingClientRect();
          const position = event.clientX < bounds.left + bounds.width / 2 ? 'before' : 'after';
          if (Number.isInteger(source) && source >= 0
            && source < references.length && source !== index) {
            onReferencesChange((current) => {
              if (source >= current.length || index >= current.length) return current;
              const next = [...current];
              const [moved] = next.splice(source, 1);
              const target = index - (source < index ? 1 : 0);
              next.splice(target + (position === 'after' ? 1 : 0), 0, moved);
              return next;
            });
          }
          referenceDragJustEnded.current = true;
          finishReferenceDrag();
        }}
        onDragEnd={() => {
          referenceDragJustEnded.current = true;
          finishReferenceDrag();
        }}>
        <button type="button" className="studio-ref-open"
          aria-label={`${t('Open image')} ${index + 1}`}
          onClick={() => {
            if (!referenceDragJustEnded.current) void onOpenReference(reference, index);
          }}>
          <img src={reference.url} alt="" draggable={false} />
        </button>
        <button type="button" className="studio-ref-remove" aria-label={t('Remove reference')}
          onClick={() => onReferencesChange((current) => current.filter((_, at) => at !== index))}>
          <X size={12} aria-hidden="true" />
        </button>
      </span>)}
    </div>}
    <textarea value={prompt} rows={1} ref={promptRef}
      aria-label={t('Generation prompt')}
      placeholder={kind === 'video'
        ? t('Describe the video…')
        : t('Describe the image you want…')}
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
      }} />
    {/* Keep the controls mounted across kind switches. The model above is
        already valid for this render, so remounting would only force
        another Chromium text raster pass. */}
    <div className="studio-composer-bar">
      <button type="button" className="studio-attach" aria-label={t('Attach reference image')}
        disabled={references.length >= maxReferences}
        data-tooltip={t('Attach reference')}
        onClick={() => fileInput.current?.click()}><Plus size={16} aria-hidden="true" /></button>
      <input ref={fileInput} type="file" accept="image/*" multiple hidden
        onChange={(event) => {
          if (event.currentTarget.files) void onFiles(event.currentTarget.files);
          event.currentTarget.value = '';
        }} />
      {/* One strip for the generation controls. It stays a SINGLE line
          (wrapping reflowed the dock on every mode switch) and scrolls
          sideways on a phone, so the model picker is never clipped —
          the chat composer keeps its route strip the same way. */}
      <div className="studio-composer-controls">
        <StudioRouteMenu entries={modelEntries} lane={lane} model={model}
          rows={routeRows} slider={slider} onSelect={onSelectModel} />
      </div>
      <span className="studio-composer-spacer" />
      {/* Never flips to a disabled spinner: each press queues another run
          and the in-flight ones report on their own tiles. */}
      <button type="button" className="studio-generate" aria-label={t('Generate')}
        data-tooltip={t('Generate')} disabled={!lane || !prompt.trim()} onClick={onGenerate}>
        <Sparkles size={16} aria-hidden="true" />
      </button>
    </div>
  </div>;
}
