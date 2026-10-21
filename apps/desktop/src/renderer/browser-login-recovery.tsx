// An expired sign-in in the managed Browser Use profile, and the two ways
// back: sign in again on the page, or copy the sign-in again from Chrome with
// the existing importer (one-shot and only while Chrome is closed, so it is
// offered here rather than re-synced automatically). The attended takeover
// card offers the import beside "Done"; the routine card of a run that
// met the expired sign-in (routine-result.mjs) offers both (agent-chat-row.tsx).
// Sign-ins are shared by every session, so signing in from the thread's pane
// is enough for the routine's next run.
import { routineLoginRequiredSite } from '../../../../src/runtime/agent/orchestrator/session/routine-result.mjs';
import { requestBrowserImport, requestBrowserPage, revealBrowserPane } from './browser-page-request';
import { t } from './i18n';

export { routineLoginRequiredSite };

const HOST = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;

/** "크롬에서 다시 가져오기": opens the session's pane with the Chrome import dialog. */
export function ChromeReimportButton({ sessionId, className }: { sessionId: string; className?: string }) {
  if (!sessionId || !window.mixdogDesktop?.browserProfileImportSources) return null;
  return (
    <button type="button" className={className} onClick={() => requestBrowserImport(sessionId)}>
      {t('Import again from Chrome')}
    </button>
  );
}

/** Sign in again on `site`'s page in the session's Browser pane. */
export function signInAgainOn(site: string, sessionId: string) {
  if (HOST.test(site)) requestBrowserPage(sessionId, `https://${site}/`);
  else revealBrowserPane(sessionId);
}
