import { Check, ChevronDown, Images, LayoutGrid } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from './i18n';
import type { StudioBoard } from './studio-boards';

/** Every board's mark: one glyph in the Sessions row slot (16px, muted ink). */
export function StudioBoardIcon() {
  return (
    <span className="session-row-slot studio-board-icon" aria-hidden="true">
      <Images size={16} strokeWidth={1.75} />
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
  onSelect,
}: {
  boards: readonly StudioBoard[];
  openId: string;
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
        {current ? <StudioBoardIcon /> : <LayoutGrid size={16} strokeWidth={1.75} aria-hidden="true" />}
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
              <LayoutGrid size={16} strokeWidth={1.75} aria-hidden="true" />
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
                <StudioBoardIcon />
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
