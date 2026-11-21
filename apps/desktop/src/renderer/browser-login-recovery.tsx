import { routineLoginRequiredSite } from '../shared/core-src/runtime/agent/orchestrator/session/routine-result.mjs';
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
