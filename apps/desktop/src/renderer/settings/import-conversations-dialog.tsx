import { X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import { isConversationImportJobActive } from '../../shared/contract-import';
import { t } from '../i18n';
import { scrimDismiss } from '../scrim-dismiss';
import { SHOW_IMPORTED_CHATS_EVENT } from '../import-conversation-events';
import { importJobStore } from '../import-job-store';
import { useMobileBack } from '../mobile-back';
import { acquireTitleBarDim } from '../titlebar-dim';
import { desktopApi, useImportJob, useImportListing } from './import-conversations-hooks';
import { importSelectionPayload } from './import-conversations-model';
import { ImportFooterContent, ImportJobView, ImportPicker, importHeading } from './import-conversations-parts';
import './import-conversations-dialog.css';

export { adoptImportJob } from './import-conversations-hooks';

export function ImportConversationsDialog({ onClose }: { onClose(): void }) {
  const titleId = `${useId()}-title`;
  const api = desktopApi();
  const listing = useImportListing(api);
  const { job, jobMode, starting, error, setError, start, stop } = useImportJob(api, onClose);

  const jobRef = useRef(job);
  jobRef.current = job;
  // Closing a finished summary acknowledges it, so it is not shown again on reopen.
  const close = () => {
    const shown = jobRef.current;
    if (shown && !isConversationImportJobActive(shown)) importJobStore.acknowledge(shown.jobId);
    onClose();
  };
  useMobileBack(true, close);
  // Fullscreen scrim: the native caption controls dim with it.
  useEffect(() => acquireTitleBarDim(), []);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => opener?.focus();
  }, []);

  const chooseFile = async () => {
    setError('');
    setError(await listing.chooseFile());
  };

  const startImport = () => {
    const { list, selection, selectedCount, settled, singleRow } = listing;
    if (!list || !settled || selectedCount === 0) return;
    void start(importSelectionPayload(selection, list.viewId), singleRow !== null, singleRow);
  };

  const viewChats = () => {
    window.dispatchEvent(new Event(SHOW_IMPORTED_CHATS_EVENT));
    close();
  };

  const batchJob = job && jobMode === 'batch' ? job : null;
  const running = batchJob !== null && isConversationImportJobActive(batchJob);
  const busy = starting || (job !== null && jobMode === 'single');

  return (
    // A backdrop press closes the dialog; Escape and the close button are the keyboard routes.
    <div className="settings-confirm-layer" {...scrimDismiss(close)}>
      <section
        className="settings-confirm-dialog settings-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-settings-nested-dialog
      >
        <header>
          <h3 id={titleId}>{importHeading(batchJob, running)}</h3>
          <button type="button" aria-label={t('Close import')} data-settings-nested-close onClick={close}>
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        {batchJob ? (
          <ImportJobView job={batchJob} running={running} />
        ) : (
          <ImportPicker listing={listing} busy={busy} error={error} onChooseFile={() => void chooseFile()} />
        )}
        <footer>
          <ImportFooterContent
            batchJob={batchJob}
            running={running}
            showEmpty={listing.showEmpty}
            selectedCount={listing.selectedCount}
            canContinue={listing.singleRow !== null}
            busy={busy}
            onStop={stop}
            onViewChats={viewChats}
            onClose={close}
            onStart={startImport}
          />
        </footer>
      </section>
    </div>
  );
}
