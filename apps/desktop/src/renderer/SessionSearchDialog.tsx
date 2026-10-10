import { MessageSquare, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';

import type { DesktopSessionContentMatch, DesktopSessionSummary } from '../shared/contract';
import { t } from './i18n';
import { acquireModalLayer } from './modal-layer';
import { sessionLabel } from './session-sidebar-rows';
import {
  SESSION_SEARCH_OPEN_EVENT,
  mergeSessionContentMatches,
  sessionSearchResults,
  type SessionSearchRow,
} from './session-search';

interface SessionSearchProps {
  sessions: readonly DesktopSessionSummary[];
  onOpenSession(sessionId: string): void;
}

/** Matches render a page at a time; the next page joins once the reader comes
 *  within a few rows of the end, by scrolling or by keyboard. */
const PAGE_ROWS = 25;
const LOAD_NEAR_ROWS = 5;
const CONTENT_SEARCH_DELAY_MS = 250;

function pathName(path: string | null | undefined): string {
  return (
    String(path || '')
      .split(/[\\/]/)
      .filter(Boolean)
      .pop() || ''
  );
}

function SessionSearchDialog({ sessions, onOpenSession, onClose }: SessionSearchProps & { onClose(): void }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [rowLimit, setRowLimit] = useState(PAGE_ROWS);

  useEffect(() => {
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const shell = document.querySelector<HTMLElement>('.app-shell');
    const layer = acquireModalLayer(shell ? [shell] : []);
    layer.attachSurface(surfaceRef.current);
    inputRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!layer.isTop()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        inputRef.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      layer.release();
      prior?.focus({ preventScroll: true });
    };
  }, []);

  const [contentHits, setContentHits] = useState<readonly DesktopSessionContentMatch[]>([]);
  const [contentPending, setContentPending] = useState(false);
  useEffect(() => {
    const text = query.trim();
    setContentHits([]);
    const search = window.mixdogDesktop?.searchSessionContent;
    if (!text || !search) {
      setContentPending(false);
      return undefined;
    }
    setContentPending(true);
    let superseded = false;
    const timer = window.setTimeout(() => {
      Promise.resolve(search(text))
        .then((hits) => {
          if (!superseded) setContentHits(Array.isArray(hits) ? hits : []);
        })
        .catch((error: unknown) => console.warn('Session content search failed', error))
        .finally(() => {
          if (!superseded) setContentPending(false);
        });
    }, CONTENT_SEARCH_DELAY_MS);
    return () => {
      superseded = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const matches = useMemo(
    () => mergeSessionContentMatches(sessions, sessionSearchResults(sessions, query), contentHits),
    [sessions, query, contentHits]
  );
  const rows = matches.slice(0, rowLimit);
  const revealNear = (index: number) => {
    if (index >= rows.length - LOAD_NEAR_ROWS && rows.length < matches.length) {
      setRowLimit((current) => current + PAGE_ROWS);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: query is the trigger that resets selection and scroll, not a value the effect reads
  useEffect(() => {
    setSelectedIndex(0);
    setRowLimit(PAGE_ROWS);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [query]);
  useEffect(() => {
    setSelectedIndex((current) => Math.max(0, Math.min(current, rows.length - 1)));
  }, [rows.length]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedIndex is the trigger; the effect finds the selected row through the DOM
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const openRow = (row: SessionSearchRow | undefined) => {
    if (!row) return;
    onClose();
    onOpenSession(row.session.id);
  };

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss; keyboard dismissal is handled by the dialog's Escape handling
    <div
      ref={surfaceRef}
      className="workbench-quick-access-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="workbench-quick-access session-search"
        role="dialog"
        aria-modal="true"
        aria-label={t('Search sessions')}
      >
        <div className="workbench-quick-input">
          <Search size={16} aria-hidden="true" />
          <input
            ref={inputRef}
            aria-label={t('Search sessions')}
            placeholder={t('Search sessions…')}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                revealNear(selectedIndex + 1);
                setSelectedIndex((current) => (rows.length ? (current + 1) % rows.length : 0));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setSelectedIndex((current) => (rows.length ? (current - 1 + rows.length) % rows.length : 0));
              } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                openRow(rows[selectedIndex]);
              }
            }}
          />
        </div>
        <div
          ref={listRef}
          className="workbench-quick-results"
          role="listbox"
          aria-label={t('Search sessions')}
          onScroll={(event) => {
            const list = event.currentTarget;
            const rowHeight = list.scrollHeight / Math.max(1, rows.length);
            if (list.scrollHeight - list.scrollTop - list.clientHeight <= rowHeight * LOAD_NEAR_ROWS) {
              revealNear(rows.length - 1);
            }
          }}
        >
          {rows.length === 0 && !contentPending && <p role="status">{t('No matching sessions')}</p>}
          {rows.length > 0 && (
            <div className="session-search-heading" role="presentation">
              {t('Sessions')}
            </div>
          )}
          {rows.map((row, index) => {
            const { session, snippet } = row;
            const active = index === selectedIndex;
            // Only a real project is named; task sessions run in internal folders.
            const meta = [pathName(session.projectPath), session.archived === true ? t('Archived') : '']
              .filter(Boolean)
              .join(' · ');
            return (
              <button
                key={session.id}
                type="button"
                role="option"
                aria-selected={active}
                className={active ? 'active' : ''}
                onMouseEnter={() => setSelectedIndex(index)}
                onMouseDown={(event: MouseEvent) => event.preventDefault()}
                onClick={() => openRow(row)}
              >
                <MessageSquare size={14} aria-hidden="true" />
                <span>
                  <b>{sessionLabel(session)}</b>
                  {snippet && <small>{snippet}</small>}
                </span>
                {meta && <small className="session-search-meta">{meta}</small>}
              </button>
            );
          })}
        </div>
      </section>
    </div>,
    document.body
  );
}

/** Mounted once by the app shell; any surface opens it through SESSION_SEARCH_OPEN_EVENT. */
export function SessionSearchHost(props: SessionSearchProps) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(SESSION_SEARCH_OPEN_EVENT, show);
    return () => window.removeEventListener(SESSION_SEARCH_OPEN_EVENT, show);
  }, []);
  return open ? <SessionSearchDialog {...props} onClose={() => setOpen(false)} /> : null;
}
