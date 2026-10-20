// "브라우저 · 보기": the one way a turn's Browser Use work reaches the screen.
// The panel never opens by itself while the agent works (only a takeover
// hand-off opens it), so the transcript carries this line instead; a press
// opens the session's panel on its current page, mid-turn or after.
import { Globe } from 'lucide-react';
import { revealBrowserPane, browserPageRequestsAvailable } from './browser-page-request';
import type { TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { linkOpenTarget } from './link-open-target';
import { desktopToolActivitySurface, flattenedToolActivityItems } from './transcript-tool-core';
import type { TranscriptRowModel } from './transcript-rows';

/** Whether a tool round drove the session's browser. */
export function toolActivityUsesBrowser(items: readonly TranscriptItem[]): boolean {
  return flattenedToolActivityItems(items).some(
    (item) => desktopToolActivitySurface(item.name, item.args).normalizedName === 'browser'
  );
}

/** Agent mode keeps one line per turn: at the turn's last browser round. */
export function lastBrowserRoundOfTurn(rows: readonly TranscriptRowModel[], index: number): boolean {
  const row = rows[index];
  if (row?._tag !== 'ToolActivity' || !toolActivityUsesBrowser(row.items)) return false;
  return !rows
    .slice(index + 1)
    .some(
      (next) => next._tag === 'ToolActivity' && next.turnKey === row.turnKey && toolActivityUsesBrowser(next.items)
    );
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

/** Hidden where no pane can be revealed (a draft with no session). */
export function BrowserPeekLine({ sessionId }: { sessionId: string }) {
  if (linkOpenTarget({ sessionId, paneAvailable: browserPageRequestsAvailable() }) !== 'pane') return null;
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
