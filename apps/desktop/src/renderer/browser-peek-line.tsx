// "브라우저 · 보기": a page the agent opened (`open`) and the host showed or
// kept for the panel. Only a successful open leaves the line; it names that
// page's tab, and a press shows exactly that tab — never re-navigating the
// shown one, never making a page. A tab no longer open says so instead.
import { Globe } from 'lucide-react';
import { useState } from 'react';
import { revealBrowserPane, browserPageRequestsAvailable } from './browser-page-request';
import { showBrowserPage } from './browser-page-view';
import type { TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { linkOpenTarget } from './link-open-target';
import { desktopToolActivitySurface, flattenedToolActivityItems } from './transcript-tool-core';
import type { TranscriptRowModel } from './transcript-rows';

/** A page an `open` placed in a panel. `ownerSessionId`/`ownerName`: the
 *  session that owns it, when a row from another session (a task session, a
 *  sub-agent) is shown in this conversation. */
export interface BrowserOpenedPage {
  tabId: string;
  title: string;
  url: string;
  ownerSessionId?: string;
  ownerName?: string;
}

// The host's `open` reply (main/browser/command-runner.ts revealOpenedPage):
// shown, or kept until the conversation is on screen. Failures never match.
const OPEN_PLACEMENT =
  /^(?:Shown in the browser panel|Not on screen yet): page (p\d+) — (.*) \((\S*)\)(?:\.|\s+is kept)/;

function resultText(value: unknown): string {
  if (typeof value === 'string') return value;
  const content = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? (value as { content?: unknown }).content
      : undefined;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part === 'object' ? String((part as { text?: unknown }).text ?? '') : ''))
    .join('\n');
}

function callAction(item: TranscriptItem): string {
  let root: unknown = item.args;
  if (typeof root === 'string') {
    try {
      root = JSON.parse(root);
    } catch {
      root = null;
    }
  }
  const action = root && typeof root === 'object' ? (root as { action?: unknown }).action : undefined;
  return typeof action === 'string'
    ? action
    : String(desktopToolActivitySurface(item.name, item.args).args.action ?? '');
}

/** The last page a tool round opened in a panel; null for a round with no
 *  successful foreground `open`. */
export function browserOpenedPage(items: readonly TranscriptItem[]): BrowserOpenedPage | null {
  let page: BrowserOpenedPage | null = null;
  for (const item of flattenedToolActivityItems(items)) {
    if (item.isError || desktopToolActivitySurface(item.name, item.args).normalizedName !== 'browser') continue;
    if (callAction(item) !== 'open') continue;
    const match = OPEN_PLACEMENT.exec(resultText(item.result ?? item.rawResult).trim());
    if (!match) continue;
    const ownerSessionId = typeof item.ownerSessionId === 'string' ? item.ownerSessionId : '';
    const ownerName = typeof item.ownerName === 'string' ? item.ownerName : '';
    page = {
      tabId: match[1],
      title: match[2] === '(untitled)' ? '' : match[2],
      url: match[3],
      ...(ownerSessionId ? { ownerSessionId } : {}),
      ...(ownerName ? { ownerName } : {}),
    };
  }
  return page;
}

/** Agent mode keeps one line per turn: at the turn's last round that opened a page. */
export function lastBrowserRoundOfTurn(rows: readonly TranscriptRowModel[], index: number): boolean {
  const row = rows[index];
  if (row?._tag !== 'ToolActivity' || !browserOpenedPage(row.items)) return false;
  return !rows
    .slice(index + 1)
    .some((next) => next._tag === 'ToolActivity' && next.turnKey === row.turnKey && browserOpenedPage(next.items));
}

// The host's reply line after a saved-login sign-in (main/browser/auto-sign-in.ts).
const SAVED_SIGN_IN = /Saved sign-in: signed in to ([^\s"\\]+) with its saved login/g;

/** The sites a tool round signed in to with a saved login, in order, once each. */
export function savedSignInSites(items: readonly TranscriptItem[]): string[] {
  const sites = new Set<string>();
  for (const item of flattenedToolActivityItems(items)) {
    if (desktopToolActivitySurface(item.name, item.args).normalizedName !== 'browser') continue;
    const value = item.result ?? item.rawResult;
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    for (const match of text.matchAll(SAVED_SIGN_IN)) sites.add(match[1]);
  }
  return [...sites];
}

/** A faint "<site>에 저장된 로그인으로 로그인했습니다" per saved-login sign-in. */
export function SavedSignInLines({ items }: { items: readonly TranscriptItem[] }) {
  const sites = savedSignInSites(items);
  if (!sites.length) return null;
  return (
    <>
      {sites.map((site) => (
        <div key={site} className="transcript-saved-sign-in">
          {t('Signed in to {{site}} with the saved login', { site })}
        </div>
      ))}
    </>
  );
}

function pageLabel(page: BrowserOpenedPage): string {
  if (page.title) return page.title;
  try {
    return new URL(page.url).host;
  } catch {
    return '';
  }
}

/** `sessionId`: the conversation showing the line, whose panel opens. A page
 *  another session owns opens there under its owner's name, without leaving
 *  this conversation. Hidden where no pane can be revealed (a draft). */
export function BrowserPeekLine({ sessionId, page }: { sessionId: string; page?: BrowserOpenedPage }) {
  const [gone, setGone] = useState(false);
  // A failed selection that is not a missing tab (a lost connection): shown
  // beside the line, which stays pressable to retry.
  const [failure, setFailure] = useState('');
  if (linkOpenTarget({ sessionId, paneAvailable: browserPageRequestsAvailable() }) !== 'pane') return null;
  // A caller naming no page (a routed child-surface line that predates page
  // ids) still opens the session's panel on its current page.
  if (!page) {
    return (
      <button
        type="button"
        className="transcript-browser-peek"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => revealBrowserPane(sessionId)}
      >
        <Globe size={14} aria-hidden="true" />
        <span>{t('Browser')}</span>
        <span aria-hidden="true">·</span>
        <b>{t('View')}</b>
      </button>
    );
  }
  const owner = page.ownerSessionId || sessionId;
  const ownerName = owner === sessionId ? '' : page.ownerName || t('Another session');
  const label = pageLabel(page);
  const parts = (
    <>
      <Globe size={14} aria-hidden="true" />
      <span>{t('Browser')}</span>
      {ownerName && (
        <>
          <span aria-hidden="true">·</span>
          <span className="transcript-browser-peek-owner">{ownerName}</span>
        </>
      )}
      {label && (
        <>
          <span aria-hidden="true">·</span>
          <span className="transcript-browser-peek-title">{label}</span>
        </>
      )}
      <span aria-hidden="true">·</span>
    </>
  );
  if (gone) {
    return (
      <div className="transcript-browser-peek is-gone" role="status">
        {parts}
        <span>{t('This tab is no longer open')}</span>
      </div>
    );
  }
  const view = async () => {
    // Show that exact tab first: one that closed (or did not survive a
    // restart) is reported here, and no panel opens onto a page made for it.
    setFailure('');
    const result = await showBrowserPage({ viewer: sessionId, owner, ownerName, tabId: page.tabId });
    if (result.status === 'gone') setGone(true);
    else if (result.status === 'failed') setFailure(result.message);
  };
  return (
    <button
      type="button"
      className="transcript-browser-peek"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => void view()}
    >
      {parts}
      {failure && (
        <>
          <span className="transcript-browser-peek-owner" role="alert">
            {failure}
          </span>
          <span aria-hidden="true">·</span>
        </>
      )}
      <b>{t('View')}</b>
    </button>
  );
}
