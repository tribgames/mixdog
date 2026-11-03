import { ChevronDown, ChevronRight, LayoutGrid, Plus, Search } from 'lucide-react';
import { useCallback, useContext, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { confirmAction } from './app-confirm';
import { showDesktopToast } from './desktop-toasts';
import { t } from './i18n';
import { useStudioPanelState } from './studio-panel-bridge';
import {
  createStudioBoard,
  deleteStudioBoard,
  openStudioBoard,
  renameStudioBoard,
  useStudioBoards,
  type StudioBoard,
} from './studio-boards';
import { StudioBoardNameInput, StudioBoardThumb, useStudioBoardThumbs } from './studio-board-components';
import { contextMenuRowProps, ScmContextMenu, type ScmContextMenuState } from './ScmContextMenu';
import { SidebarPanelHeaderSlot, toggleHeading } from './session-sidebar-sections';
import { SessionRowStatusIcon } from './session-status-mark';
import { errorText, type StudioApi } from './studio-support';

/** The count at a row's end, or the running spinner while a run in it is in flight. */
function RowEnd({ count, working, name }: { count: number; working: boolean; name: string }) {
  return working ? (
    <span className="session-row-status" data-working>
      <SessionRowStatusIcon status="running" name={name} />
    </span>
  ) : (
    <span className="studio-board-count">{count}</span>
  );
}

/** The Studio rail page: "전체" (every result), then the boards, one
 *  Sessions-sized row each. Nothing is fetched while it is not shown. */
export function StudioPanel({
  active,
  api = window.mixdogDesktop,
  onShowStudio,
}: {
  active: boolean;
  api?: StudioApi;
  /** Brings Studio forward (showing the board just opened). */
  onShowStudio(): void;
}) {
  const { boards, total, openId, loaded } = useStudioBoards(api, active);
  const { jobs } = useStudioPanelState();
  const { thumbUrl, onThumbError } = useStudioBoardThumbs(api, active, boards);
  const slot = useContext(SidebarPanelHeaderSlot);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [boardsClosed, setBoardsClosed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState('');
  const [menu, setMenu] = useState<ScmContextMenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  // Which boards (and "no board", '') have a run in flight.
  const workingBoards = useMemo(
    () => new Set(jobs.filter((entry) => entry.status === 'running').map((entry) => entry.request?.boardId ?? '')),
    [jobs]
  );
  const needle = searching ? query.trim().toLowerCase() : '';
  const shownBoards = needle ? boards.filter((board) => board.name.toLowerCase().includes(needle)) : boards;

  const fail = (reason: unknown) => showDesktopToast(errorText(reason), 'error');
  const open = (id: string) => {
    openStudioBoard(id);
    onShowStudio();
  };
  const create = (name: string) => {
    setCreating(false);
    void createStudioBoard(api, name)
      .then((board) => {
        if (board) openStudioBoard(board.id);
      })
      .catch(fail);
  };
  const rename = (board: StudioBoard, name: string) => {
    setRenamingId('');
    void renameStudioBoard(api, board.id, name).catch(fail);
  };
  const remove = (board: StudioBoard) => {
    const message = t('Delete board "{{name}}"? Its results stay in All.', { name: board.name });
    void confirmAction(message, { danger: true, confirmLabel: t('Delete') })
      .then((confirmed) => (confirmed ? deleteStudioBoard(api, board.id) : undefined))
      .catch(fail);
  };
  const openMenu = (board: StudioBoard, point: { x: number; y: number }) =>
    setMenu({
      label: board.name,
      ...point,
      items: [
        { id: 'open', label: t('Open'), onSelect: () => open(board.id) },
        { id: 'rename', label: t('Rename'), onSelect: () => setRenamingId(board.id) },
        {
          id: 'delete',
          label: t('Delete board'),
          danger: true,
          separatorBefore: true,
          onSelect: () => remove(board),
        },
      ],
    });

  const actions = (
    <>
      <button
        type="button"
        className="session-panel-action"
        aria-label={t('Search')}
        data-tooltip={t('Search')}
        aria-pressed={searching}
        onClick={() => {
          setSearching((value) => !value);
          setQuery('');
        }}
      >
        <Search size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="session-panel-action"
        aria-label={t('New board')}
        data-tooltip={t('New board')}
        onClick={() => {
          setBoardsClosed(false);
          setCreating(true);
        }}
      >
        <Plus size={16} aria-hidden="true" />
      </button>
    </>
  );

  const boardRow = (board: StudioBoard) => {
    const selected = openId === board.id;
    if (renamingId === board.id) {
      return (
        <div className="session-row editing studio-board-row" key={board.id} data-board-id={board.id}>
          <StudioBoardNameInput
            initial={board.name}
            label={t('Rename {{name}}', { name: board.name })}
            onCommit={(name) => rename(board, name)}
            onCancel={() => setRenamingId('')}
          />
        </div>
      );
    }
    return (
      <div
        className={`session-row studio-board-row${selected ? ' selected' : ''}`}
        key={board.id}
        data-board-id={board.id}
        {...contextMenuRowProps((point) => openMenu(board, point))}
      >
        <button
          type="button"
          className="session-row-main"
          aria-current={selected ? 'true' : undefined}
          aria-haspopup="menu"
          data-tooltip={board.name}
          onClick={() => open(board.id)}
          onDoubleClick={() => setRenamingId(board.id)}
          onKeyDown={(event) => {
            if (event.key !== 'F2') return;
            event.preventDefault();
            setRenamingId(board.id);
          }}
        >
          <StudioBoardThumb board={board} src={thumbUrl(board)} onError={onThumbError} />
          <span className="session-row-copy">
            <b>{board.name}</b>
          </span>
          <RowEnd count={board.count} working={workingBoards.has(board.id)} name={board.name} />
        </button>
      </div>
    );
  };

  return (
    <div className="studio-panel">
      {slot ? (active ? createPortal(actions, slot) : null) : actions}
      {searching && (
        <input
          className="agent-pane-search"
          type="search"
          // biome-ignore lint/a11y/noAutofocus: the search button opens this field to type into
          autoFocus
          value={query}
          placeholder={t('Search boards')}
          aria-label={t('Search boards')}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setSearching(false);
          }}
        />
      )}
      <section className="sidebar-recent studio-panel-all" aria-label={t('All')}>
        <nav className="session-list recent-session-list">
          <div className={`session-row studio-all-row${openId ? '' : ' selected'}`} data-board-id="">
            <button
              type="button"
              className="session-row-main"
              aria-current={openId ? undefined : 'true'}
              onClick={() => open('')}
            >
              <span className="session-row-slot" aria-hidden="true">
                <LayoutGrid size={15} />
              </span>
              <span className="session-row-copy">
                <b>{t('All')}</b>
              </span>
              <RowEnd count={total} working={workingBoards.has('')} name={t('All')} />
            </button>
          </div>
        </nav>
      </section>
      <section className="sidebar-recent" aria-label={t('Boards')}>
        <div className="sidebar-category-header">
          <button
            type="button"
            className="sidebar-recent-heading sidebar-heading-toggle"
            aria-expanded={!boardsClosed}
            onClick={toggleHeading(() => setBoardsClosed((value) => !value))}
          >
            <span>{t('Boards')}</span>
            {boardsClosed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </button>
        </div>
        {!boardsClosed && (
          <nav className="session-list recent-session-list">
            {creating && (
              <div className="session-row editing studio-board-row" data-board-id="new">
                <StudioBoardNameInput
                  initial=""
                  label={t('New board')}
                  onCommit={create}
                  onCancel={() => setCreating(false)}
                />
              </div>
            )}
            {shownBoards.map(boardRow)}
            {loaded && !creating && shownBoards.length === 0 && (
              <p className="sidebar-section-empty studio-board-empty">
                {needle ? t('No results') : t('No boards yet.')}
              </p>
            )}
          </nav>
        )}
      </section>
      <ScmContextMenu state={menu} onClose={closeMenu} />
    </div>
  );
}
