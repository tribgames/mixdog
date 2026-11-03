import { Check, ChevronDown, LayoutGrid } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from './i18n';
import type { StudioBoard } from './studio-boards';
import { StudioThumbnail } from './studio-media-components';
import { useStudioMediaUrls } from './studio-media-state';
import { useStudioThumbnailHydration, useStudioThumbnailState } from './studio-pane-thumbnails';
import { type MediaAsset, posterFromVideo, type StudioApi } from './studio-support';

/** Board thumbnails (each board's latest result). The desktop byte lane only
 *  serves a rendition that already exists, so a cover nobody has shown yet
 *  misses there; like the gallery, those covers are filled by the renderer
 *  fallback (which also caches the rendition for the byte lane). */
export function useStudioBoardThumbs(api: StudioApi, active: boolean, boards: readonly StudioBoard[]) {
  const { assetUrl, laneReady, localTransport, markUrlBroken } = useStudioMediaUrls(api, active);
  const thumbnails = useStudioThumbnailState();
  const coverKey = boards.map((board) => (board.cover ? `${board.cover.id}:${board.cover.kind}` : '')).join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: coverKey is the covers' identity
  const covers = useMemo(
    () =>
      boards.flatMap((board) =>
        board.cover ? [{ id: board.cover.id, kind: board.cover.kind, mime: '' } as MediaAsset] : []
      ),
    [coverKey]
  );
  useStudioThumbnailHydration({
    state: thumbnails.hydration,
    active,
    api,
    assetUrl,
    captureVideoPoster: posterFromVideo,
    laneReady,
    localTransport,
    visibleAssets: covers,
  });
  const { thumbs } = thumbnails;
  const thumbUrl = useCallback(
    (board: StudioBoard): string => (board.cover ? thumbs[board.cover.id] || assetUrl(board.cover.id, 'thumb') : ''),
    [assetUrl, thumbs]
  );
  const onThumbError = useCallback((assetId: string) => markUrlBroken(assetId, 'thumb'), [markUrlBroken]);
  return { thumbUrl, onThumbError };
}

/** A board's rounded thumbnail: its latest result, an empty plate before one. */
export function StudioBoardThumb({
  board,
  src,
  className = '',
  onError,
}: {
  board: StudioBoard;
  src: string;
  className?: string;
  onError?(assetId: string): void;
}) {
  const cover = board.cover;
  return (
    <span className={`session-agent-avatar studio-panel-thumb ${className}`.trim()} aria-hidden="true">
      {cover && src && (
        <StudioThumbnail
          src={src}
          kind={cover.kind}
          eager={false}
          onLoad={() => {}}
          onError={() => onError?.(cover.id)}
        />
      )}
    </span>
  );
}

/** The inline name field for a new or renamed board: Enter or leaving the
 *  field keeps a non-blank name, Escape drops the edit. */
export function StudioBoardNameInput({
  initial,
  label,
  onCommit,
  onCancel,
}: {
  initial: string;
  label: string;
  onCommit(name: string): void;
  onCancel(): void;
}) {
  const [draft, setDraft] = useState(initial);
  const done = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const finish = (keep: boolean) => {
    if (done.current) return;
    done.current = true;
    const name = draft.trim();
    if (keep && name && name !== initial) onCommit(name);
    else onCancel();
  };
  return (
    <input
      ref={input}
      className="session-title-input studio-board-name-input"
      value={draft}
      maxLength={120}
      aria-label={label}
      placeholder={t('Board name')}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          finish(true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}

/** The composer line's left control: the board new runs join. It opens a
 *  list of "전체" (no board) and every board, upward like the model picker. */
export function StudioBoardPicker({
  boards,
  openId,
  thumbUrl,
  onThumbError,
  onSelect,
}: {
  boards: readonly StudioBoard[];
  openId: string;
  thumbUrl(board: StudioBoard): string;
  onThumbError(assetId: string): void;
  onSelect(boardId: string): void;
}) {
  const [box, setBox] = useState<{ left: number; bottom: number } | null>(null);
  const open = Boolean(box);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const setOpen = (next: boolean) => {
    const rect = root.current?.getBoundingClientRect();
    setBox(next && rect ? { left: rect.left, bottom: window.innerHeight - rect.top + 6 } : null);
  };
  const current = boards.find((board) => board.id === openId) ?? null;
  useEffect(() => {
    if (!open) return undefined;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !menu.current?.contains(target)) setBox(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setBox(null);
    };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);
  const choose = (id: string) => {
    setBox(null);
    onSelect(id);
  };
  const label = current ? current.name : t('No board');
  return (
    <div className="studio-board-picker" ref={root}>
      <button
        type="button"
        className="studio-board-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('Board: {{name}}', { name: label })}
        data-tooltip={t('Board for new results')}
        onClick={() => setOpen(!open)}
      >
        {current ? (
          <StudioBoardThumb
            board={current}
            src={thumbUrl(current)}
            className="studio-board-trigger-thumb"
            onError={onThumbError}
          />
        ) : (
          <LayoutGrid size={14} aria-hidden="true" />
        )}
        <span className="studio-board-trigger-label">{label}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {box &&
        createPortal(
          <div
            ref={menu}
            className="studio-board-menu"
            role="menu"
            aria-label={t('Boards')}
            style={{ left: box.left, bottom: box.bottom }}
          >
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!current}
              className="studio-board-menu-item"
              onClick={() => choose('')}
            >
              <LayoutGrid size={14} aria-hidden="true" />
              <span>{t('No board')}</span>
              {!current && <Check size={14} aria-hidden="true" />}
            </button>
            {boards.map((board) => (
              <button
                key={board.id}
                type="button"
                role="menuitemradio"
                aria-checked={board.id === openId}
                className="studio-board-menu-item"
                onClick={() => choose(board.id)}
              >
                <StudioBoardThumb
                  board={board}
                  src={thumbUrl(board)}
                  className="studio-board-trigger-thumb"
                  onError={onThumbError}
                />
                <span>{board.name}</span>
                {board.id === openId && <Check size={14} aria-hidden="true" />}
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  );
}
