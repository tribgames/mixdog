import { useEffect, useRef, useState } from 'react';
import type {
  ConversationImportJob,
  ConversationImportRow,
  ConversationImportSource,
} from '../../shared/contract-import';
import { t } from '../i18n';
import { OpenSelect } from '../OpenSelect';
import type { ImportListing } from './import-conversations-hooks';
import {
  IMPORT_FAILURES_SHOWN,
  IMPORT_TIME_RANGES,
  importButtonLabel,
  importCodeMessage,
  importFailureSummary,
  importWarningCodes,
  isRowSelected,
  projectLabel,
  toggleImportRow,
  toggleSelectAll,
  type ImportTimeRange,
} from './import-conversations-model';
import { relativeWhen } from './relative-when';

const NEAR_END_PX = 240;

const SOURCES: ReadonlyArray<{ value: ConversationImportSource; label: string }> = [
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude Code' },
  { value: 'devin', label: 'Devin CLI' },
];

export function importHeading(job: ConversationImportJob | null, running: boolean): string {
  if (!job) return t('Import conversations');
  if (running) return t('Importing conversations');
  if (job.state === 'stopped') return t('Import stopped');
  if (job.state === 'failed') return t('Import failed');
  return t('Import finished');
}

export function ImportJobView({ job, running }: { job: ConversationImportJob; running: boolean }) {
  if (running) return <ImportProgress job={job} />;
  return <ImportSummary job={job} />;
}

export function ImportPicker({
  listing,
  busy,
  error,
  onChooseFile,
}: {
  listing: ImportListing;
  busy: boolean;
  error: string;
  onChooseFile(): void;
}) {
  const { showEmpty } = listing;
  return (
    <>
      <ImportToolbar listing={listing} busy={busy} />
      {!showEmpty && <ImportFilters listing={listing} busy={busy} />}
      {showEmpty ? (
        <ImportEmptyState listing={listing} onChooseFile={onChooseFile} />
      ) : (
        <ImportListView listing={listing} busy={busy} />
      )}
      {error && (
        <p className="settings-import-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function ImportToolbar({ listing, busy }: { listing: ImportListing; busy: boolean }) {
  return (
    <div className="settings-import-toolbar">
      <fieldset className="settings-import-seg" aria-label={t('App to import from')}>
        {SOURCES.map((entry) => (
          <button
            key={entry.value}
            type="button"
            aria-pressed={listing.source === entry.value}
            disabled={busy}
            onClick={() => listing.selectSource(entry.value)}
          >
            {entry.label}
          </button>
        ))}
      </fieldset>
      {!listing.showEmpty && (
        <input
          type="search"
          className="settings-import-search"
          value={listing.query}
          disabled={busy}
          aria-label={t('Search conversations')}
          placeholder={t('Search conversations')}
          spellCheck={false}
          onChange={(event) => listing.setQuery(event.target.value)}
        />
      )}
    </div>
  );
}

function ImportFilters({ listing, busy }: { listing: ImportListing; busy: boolean }) {
  return (
    <div className="settings-import-filters">
      <OpenSelect
        className="settings-select"
        ariaLabel={t('Project')}
        value={listing.project}
        disabled={busy}
        options={[
          { value: '', label: t('All projects') },
          ...listing.projectOptions.map((entry) => ({
            value: entry.cwd,
            label: `${projectLabel(entry.cwd)} (${entry.count})`,
          })),
        ]}
        onChange={listing.setProject}
      />
      <OpenSelect
        className="settings-select"
        ariaLabel={t('Time range')}
        value={listing.range}
        disabled={busy}
        options={IMPORT_TIME_RANGES.map((entry) => ({ value: entry.value, label: entry.label() }))}
        onChange={(value) => listing.setRange(value as ImportTimeRange)}
      />
    </div>
  );
}

function ImportEmptyState({ listing, onChooseFile }: { listing: ImportListing; onChooseFile(): void }) {
  const sourceName = SOURCES.find((entry) => entry.value === listing.source)?.label ?? '';
  return (
    <div className="settings-import-empty">
      <b>
        {listing.source === 'codex'
          ? t('No Codex conversations to import')
          : listing.source === 'claude'
            ? t('No Claude Code conversations to import')
            : t('No Devin CLI conversations to import')}
      </b>
      <p>{t('No conversations were found in:')}</p>
      <code>{listing.list?.searchedRoot}</code>
      <p>{t('If you use {{app}} somewhere else, choose a file yourself.', { app: sourceName })}</p>
      <button type="button" className="settings-import-secondary" onClick={onChooseFile}>
        {t('Choose file…')}
      </button>
    </div>
  );
}

function ImportListView({ listing, busy }: { listing: ImportListing; busy: boolean }) {
  const { list, rows, selection, setSelection, pinned, allState, selectableCount, settled, canSelectAll } = listing;
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = allState === 'mixed';
  }, [allState]);
  const pinnedLocked = (id: string) => id === pinned?.id && selection.all;

  return (
    <>
      <div className="settings-import-select-all">
        <label>
          <input
            ref={selectAllRef}
            type="checkbox"
            checked={allState === 'all'}
            disabled={busy || !canSelectAll || selectableCount === 0}
            onChange={() => setSelection((current) => toggleSelectAll(current, selectableCount))}
          />
          <span>{t('Select all conversations')}</span>
        </label>
        <span className="settings-import-count">
          {list ? t('{{count}} conversations', { count: list.matchedCount }) : ''}
        </span>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a <fieldset> does not scroll as an overflow container in Chromium, and this list pages in rows on scroll. */}
      <div
        role="group"
        className="settings-import-list"
        aria-label={t('Conversations')}
        aria-busy={listing.loading || listing.loadingMore}
        onScroll={(event) => {
          const el = event.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END_PX) listing.loadMore();
        }}
      >
        {rows.map((row) => (
          <ImportRow
            key={row.id}
            row={row}
            checked={isRowSelected(selection, row) && !pinnedLocked(row.id)}
            disabled={busy || !settled || pinnedLocked(row.id)}
            onToggle={() => setSelection((current) => toggleImportRow(current, row))}
          />
        ))}
        {list && rows.length === 0 && list.complete && (
          <p className="settings-import-note">{t('No conversations match your filters.')}</p>
        )}
        {((listing.loading && !list) || listing.loadingMore) && <p className="settings-import-note">{t('Loading…')}</p>}
        {listing.listError && (
          <p className="settings-import-note" role="alert">
            {t('Conversations could not be listed.')}
          </p>
        )}
      </div>
      <p className="settings-import-note settings-import-scanning" role="status">
        {listing.scanning ? t('Still scanning…') : ''}
      </p>
    </>
  );
}

function ImportRow({
  row,
  checked,
  disabled,
  onToggle,
}: {
  row: ConversationImportRow;
  checked: boolean;
  disabled: boolean;
  onToggle(): void;
}) {
  return (
    <label
      className="settings-import-item"
      title={row.warnings.length ? row.warnings.map(importCodeMessage).join('\n') : undefined}
    >
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} />
      <span className="settings-import-item-title">{row.title || t('Untitled session')}</span>
      <span className="settings-import-item-time">{relativeWhen(row.modifiedAt)}</span>
      <span className="settings-import-item-meta">
        <span className="settings-import-item-path" title={row.cwd ?? undefined}>
          {row.cwd ?? '—'}
        </span>
        {row.messageCount !== null && <span>· {t('{{count}} messages', { count: row.messageCount })}</span>}{' '}
      </span>
    </label>
  );
}

function ImportProgress({ job }: { job: ConversationImportJob }) {
  const current = job.current?.title;
  return (
    <div className="settings-import-progress">
      <div className="settings-import-progress-line">
        <b>
          {job.processed} / {job.total}
        </b>
      </div>
      <div
        className="settings-import-bar"
        role="progressbar"
        aria-label={t('Import progress')}
        aria-valuemin={0}
        aria-valuemax={job.total}
        aria-valuenow={job.processed}
      >
        <i style={{ width: `${job.total ? Math.min(100, (job.processed / job.total) * 100) : 0}%` }} />
      </div>
      {current ? <small>{current}</small> : null}
    </div>
  );
}

function ImportSummary({ job }: { job: ConversationImportJob }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggleExpanded = (code: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(code)) next.add(code);
      return next;
    });
  const failures = importFailureSummary(job, expanded);
  const warnings = importWarningCodes(job);
  return (
    <div className="settings-import-result">
      {(job.imported > 0 || !job.errorCode) && <b>{t('Imported {{count}} conversations', { count: job.imported })}</b>}
      {job.errorCode && (
        <p className="settings-import-error" role="alert">
          {importCodeMessage(job.errorCode)}
        </p>
      )}
      <ul>
        {job.skippedAlreadyImported > 0 && (
          <li>{t('Skipped {{count}} already imported', { count: job.skippedAlreadyImported })}</li>
        )}
        {job.failed > 0 && <li>{t('{{count}} could not be imported', { count: job.failed })}</li>}
        {failures.map((entry) => (
          <li key={`failure:${entry.code}`}>
            {importCodeMessage(entry.code)} ({entry.count})
            <ul className="settings-import-failed">
              {entry.records.map((record) => (
                <li key={record.candidateId}>{record.label}</li>
              ))}
            </ul>
            {entry.count > IMPORT_FAILURES_SHOWN && (
              <button
                type="button"
                className="settings-import-failed-toggle"
                onClick={() => toggleExpanded(entry.code)}
              >
                {expanded.has(entry.code) ? t('Show less') : `${t('Show all')} (${entry.count})`}
              </button>
            )}
          </li>
        ))}
        {warnings.map((code) => (
          <li key={`warning:${code}`}>{importCodeMessage(code)}</li>
        ))}
      </ul>
    </div>
  );
}

interface FooterProps {
  batchJob: ConversationImportJob | null;
  running: boolean;
  showEmpty: boolean;
  selectedCount: number;
  canContinue: boolean;
  busy: boolean;
  onStop(): void;
  onViewChats(): void;
  onClose(): void;
  onStart(): void;
}

export function ImportFooterContent(props: FooterProps) {
  const { batchJob, running, showEmpty, selectedCount, canContinue, busy, onStop, onViewChats, onClose, onStart } =
    props;
  if (batchJob && running) return <RunningFooter job={batchJob} onStop={onStop} />;
  if (batchJob) return <FinishedFooter job={batchJob} onViewChats={onViewChats} onClose={onClose} />;
  if (showEmpty) {
    return (
      <>
        <small />
        <button type="button" onClick={onClose}>
          {t('Close')}
        </button>
      </>
    );
  }
  return (
    <>
      <small>{t('Only messages and short tool notes are copied; the original files stay unchanged.')}</small>
      <div className="settings-import-actions">
        <button type="button" onClick={onClose}>
          {t('Cancel')}
        </button>
        <button type="button" className="primary" disabled={selectedCount === 0 || busy} onClick={onStart}>
          {busy ? t('Importing…') : importButtonLabel(selectedCount, canContinue)}
        </button>
      </div>
    </>
  );
}

function RunningFooter({ job, onStop }: { job: ConversationImportJob; onStop(): void }) {
  return (
    <>
      <small>{t('Keeps running in the background if you close this')}</small>
      <button type="button" disabled={job.state === 'stopping'} onClick={onStop}>
        {job.state === 'stopping' ? t('Stopping…') : t('Stop')}
      </button>
    </>
  );
}

function FinishedFooter({
  job,
  onViewChats,
  onClose,
}: {
  job: ConversationImportJob;
  onViewChats(): void;
  onClose(): void;
}) {
  return (
    <>
      <small>
        {job.byProject
          .filter((entry) => entry.imported > 0)
          .map((entry) =>
            t('{{project}} {{number}}', { project: projectLabel(entry.projectPath), number: entry.imported })
          )
          .join(' · ')}
      </small>
      {job.imported > 0 ? (
        <button type="button" className="primary" onClick={onViewChats}>
          {t('View chats')}
        </button>
      ) : (
        <button type="button" onClick={onClose}>
          {t('Close')}
        </button>
      )}
    </>
  );
}
