// Host-file downloads of a remote surface (GitHub #40): one small panel with
// a row per file — progress, rate, time left, the saving/sharing phase, a
// cancel button while it runs, and a persistent reason with Retry when it
// fails. Same presentation and AbortController pattern as server-transfers.tsx;
// the bytes move through file-download-transfer.ts.
import { useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Download, RotateCcw, Share2, X } from 'lucide-react';
import { fileDownloadErrorReason, type FileDownloadSource, type FolderLeftOut } from '../shared/file-downloads';
import {
  defaultFileDownloadEnvironment,
  FileDownloadCancelledError,
  fileDownloadFailureMessage,
  fileDownloadReasonMessage,
  fileDownloadSupport,
  FileSaveError,
  fileSaveFailureMessage,
  remainingMs,
  runFileDownload,
  transferRate,
  type FileDownloadEnvironment,
  type FileDownloadOutcome,
  type FileDownloadPhase,
  type FileDownloadSupport,
  type NativeShareResult,
} from './file-download-transfer';
import { t } from './i18n';
import { formatBytes } from './studio-support';
import { uiTimeUnit } from './ui-format';
import './file-download-panel.css';

interface DownloadRow {
  id: number;
  /** The download source, so one file never gets two rows. */
  key: string;
  name: string;
  /** `unsaved`: finished natively but only in staging; sharing keeps it. */
  status: 'running' | 'failed' | 'done' | 'unsaved';
  phase: FileDownloadPhase;
  received: number;
  total: number;
  rate: number | null;
  remaining: number | null;
  /** Failure reason or completion note. */
  message: string;
  /** What a folder zip left out; '' when nothing (or not a folder). */
  leftOut: string;
  retryable: boolean;
  cancel(): void;
  retry(): void;
  dismiss(): void;
  /** Present on `unsaved` rows: the share sheet again. */
  shareAgain?: () => void;
}

const RATE_WINDOW_MS = 4_000;
const DONE_ROW_MS = 4_000;
const noop = () => {};

let rows: DownloadRow[] = [];
let sequence = 0;
let mount: { host: HTMLElement; root: Root } | null = null;

function timeLeft(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return seconds < 60 ? uiTimeUnit(seconds, 'second') : uiTimeUnit(Math.ceil(seconds / 60), 'minute');
}

function statusText(row: DownloadRow): string {
  if (row.status !== 'running') return row.message;
  if (row.phase === 'preparing') return t('Preparing download…');
  if (row.phase === 'saving') return t('Saving on this device…');
  if (row.phase === 'sharing') return t('Opening the share sheet…');
  const parts = [`${formatBytes(row.received) || '0 KB'} / ${formatBytes(row.total) || '0 KB'}`];
  if (row.rate) parts.push(`${formatBytes(row.rate) || '0 KB'}/s`);
  if (row.remaining !== null) parts.push(t('{{time}} left', { time: timeLeft(row.remaining) }));
  return parts.join(' · ');
}

function FileDownloads({ downloads }: { downloads: DownloadRow[] }) {
  return (
    <section className="file-downloads" aria-label={t('Downloads from the PC')} aria-live="polite">
      {downloads.map((row) => {
        const running = row.status === 'running';
        const nameId = `file-download-${row.id}-name`;
        return (
          <div className="file-download" key={row.id} data-status={row.status} data-phase={row.phase}>
            <Download size={14} aria-hidden="true" />
            <span className="file-download-name" id={nameId} title={row.name}>
              {row.name || t('Preparing download…')}
            </span>
            <span className="file-download-actions">
              {row.shareAgain && (
                <button
                  type="button"
                  className="file-download-button"
                  aria-label={t('Share {{name}} again', { name: row.name })}
                  data-tooltip={t('Share again')}
                  onClick={row.shareAgain}
                >
                  <Share2 size={14} aria-hidden="true" />
                </button>
              )}
              {row.status === 'failed' && row.retryable && (
                <button
                  type="button"
                  className="file-download-button"
                  aria-label={t('Retry download of {{name}}', { name: row.name })}
                  data-tooltip={t('Retry')}
                  onClick={row.retry}
                >
                  <RotateCcw size={14} aria-hidden="true" />
                </button>
              )}
              {running && row.phase !== 'sharing' && (
                <button
                  type="button"
                  className="file-download-button"
                  aria-label={t('Cancel download of {{name}}', { name: row.name })}
                  data-tooltip={t('Cancel')}
                  onClick={row.cancel}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              )}
              {!running && (
                <button
                  type="button"
                  className="file-download-button"
                  aria-label={t('Dismiss {{name}}', { name: row.name })}
                  data-tooltip={t('Dismiss')}
                  onClick={row.dismiss}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </span>
            <span className="file-download-status" role={row.status === 'failed' ? 'alert' : undefined}>
              {statusText(row)}
            </span>
            {row.leftOut && row.status !== 'running' && row.status !== 'failed' && (
              <span className="file-download-note">{row.leftOut}</span>
            )}
            {running && (
              <progress
                aria-labelledby={nameId}
                value={row.phase === 'downloading' || row.phase === 'saving' ? row.received : undefined}
                max={Math.max(1, row.total)}
              />
            )}
          </div>
        );
      })}
    </section>
  );
}

function render(): void {
  if (!rows.length) {
    mount?.root.unmount();
    mount?.host.remove();
    mount = null;
    return;
  }
  if (!mount) {
    const host = document.createElement('div');
    document.body.append(host);
    mount = { host, root: createRoot(host) };
  }
  mount.root.render(<FileDownloads downloads={[...rows]} />);
}

/** The one line saying what a download left out (a folder zip's files, a long
 *  document's later pages); '' when it left out nothing. */
function leftOutText(leftOut: FolderLeftOut | undefined): string {
  if (leftOut?.pages) {
    return t('Included the first {{included}} of {{total}} pages', {
      included: leftOut.pages.included.toLocaleString(),
      total: leftOut.pages.total.toLocaleString(),
    });
  }
  const ignored = leftOut?.ignored ?? 0;
  const secret = leftOut?.secret ?? 0;
  const counts = { ignored: ignored.toLocaleString(), secret: secret.toLocaleString() };
  if (ignored && secret) return t('Left out {{ignored}} ignored files and {{secret}} secret files', counts);
  if (ignored) return t('Left out {{ignored}} ignored files', counts);
  if (secret) return t('Left out {{secret}} secret files', counts);
  return '';
}

function doneMessage(outcome: FileDownloadOutcome): string {
  if (outcome.result === 'shared') return t('Shared');
  if (outcome.result === 'share-failed') return t('Saved to this device; sharing failed.');
  if (outcome.result === 'saved-before-cancel') return t('Cancelled after the file was already saved to this device.');
  if (outcome.destination === 'native') return t('Saved to this device');
  return t('Download started');
}

/** Whether trying again can succeed without an update or another file. */
function retryable(error: unknown): boolean {
  const reason = fileDownloadErrorReason(error);
  if (reason)
    return !['not-linked', 'outside-project', 'sensitive', 'too-large', 'host-too-old', 'not-a-file'].includes(reason);
  if (error instanceof FileSaveError) return !['no-sink', 'browser-too-large'].includes(error.reason);
  return true;
}

/** Downloads one host file to this device with a row in the panel. Each try
 *  (Retry included) asks the host for a fresh grant. */
export function startFileDownload(
  source: FileDownloadSource,
  name: string,
  env: FileDownloadEnvironment = defaultFileDownloadEnvironment()
): void {
  // The same file already has a row: a running one is left alone; a failed
  // one is tried again in place instead of stacking a second row.
  const key = JSON.stringify(source);
  const existing = rows.find((entry) => entry.key === key && (entry.status === 'running' || entry.status === 'failed'));
  if (existing) {
    if (existing.status === 'failed') existing.retry();
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const remove = () => {
    clearTimeout(timer);
    rows = rows.filter((entry) => entry !== row);
    render();
  };
  const done = (message: string) => {
    Object.assign(row, { status: 'done', message, shareAgain: undefined });
    render();
    // A note about left-out files stays long enough to read.
    timer = setTimeout(remove, row.leftOut ? DONE_ROW_MS * 3 : DONE_ROW_MS);
  };
  // The file lives only in the shell's staging: it stays until shared or
  // dismissed, never reported as saved.
  const unsaved = (
    share: () => Promise<NativeShareResult>,
    status: 'unsaved' | 'done' = 'unsaved',
    message = t('Not saved yet — share it to keep it')
  ) => {
    Object.assign(row, {
      status,
      message,
      shareAgain: () => {
        Object.assign(row, { status: 'running', phase: 'sharing', shareAgain: undefined });
        render();
        void share().then((result) => {
          if (result === 'shared') done(t('Shared'));
          else if (result === 'expired') {
            Object.assign(row, {
              status: 'failed',
              message: t('The unsaved copy on this device expired. Download it again.'),
              retryable: true,
            });
            render();
          } else unsaved(share, status, message);
        });
      },
    });
    render();
  };
  const row: DownloadRow = {
    id: ++sequence,
    key,
    name,
    status: 'running',
    phase: 'preparing',
    received: 0,
    total: 0,
    rate: null,
    remaining: null,
    message: '',
    leftOut: '',
    retryable: false,
    cancel: noop,
    retry: noop,
    dismiss: remove,
  };
  const run = () => {
    clearTimeout(timer);
    const controller = new AbortController();
    const samples: { at: number; bytes: number }[] = [];
    Object.assign(row, {
      status: 'running',
      phase: 'preparing',
      received: 0,
      rate: null,
      remaining: null,
      message: '',
      leftOut: '',
      shareAgain: undefined,
      cancel: () => controller.abort(),
    });
    render();
    runFileDownload(env, source, {
      signal: controller.signal,
      onProgress: (progress) => {
        const at = Date.now();
        samples.push({ at, bytes: progress.received });
        while (samples.length > 2 && at - samples[0].at > RATE_WINDOW_MS) samples.shift();
        const rate = progress.phase === 'downloading' ? transferRate(samples) : null;
        Object.assign(row, {
          phase: progress.phase,
          name: progress.name || row.name,
          received: progress.received,
          total: progress.total,
          rate,
          remaining: remainingMs(rate, progress.received, progress.total),
        });
        render();
      },
    }).then(
      (outcome) => {
        // A browser share sheet the user closed saved nothing, by choice.
        if (outcome.result === 'dismissed' && outcome.destination !== 'native') {
          remove();
          return;
        }
        row.name = outcome.name || row.name;
        row.leftOut = leftOutText(outcome.leftOut);
        const kept = outcome.result === 'shared' || outcome.result === 'saved-before-cancel';
        if (outcome.persisted === false && !kept && outcome.shareAgain) {
          unsaved(outcome.shareAgain);
          return;
        }
        // A browser download the page assembled: the row keeps Save / Share
        // for a fresh tap (a long read loses the activation a sheet needs).
        if (outcome.destination === 'blob' && !kept && outcome.shareAgain) {
          unsaved(outcome.shareAgain, 'done', doneMessage(outcome));
          return;
        }
        done(doneMessage(outcome));
      },
      (error: unknown) => {
        if (error instanceof FileDownloadCancelledError) {
          remove();
          return;
        }
        Object.assign(row, {
          status: 'failed',
          message: fileDownloadFailureMessage(error),
          retryable: retryable(error),
        });
        render();
      }
    );
  };
  row.retry = run;
  rows = [...rows, row];
  run();
}

/** The download action's state on this surface: null while unknown (or
 *  `enabled` is false), else ready or blocked with its reason. */
export function useFileDownloadSupport(enabled: boolean): FileDownloadSupport | null {
  const [support, setSupport] = useState<FileDownloadSupport | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void fileDownloadSupport(defaultFileDownloadEnvironment()).then((next) => {
      if (active) setSupport(next);
    });
    return () => {
      active = false;
    };
  }, [enabled]);
  return enabled ? support : null;
}

/** Why the action is unavailable, for a disabled control; undefined when it may run. */
export function fileDownloadBlockedReason(support: FileDownloadSupport | null): string | undefined {
  if (support?.state !== 'blocked') return undefined;
  return support.reason === 'host-too-old'
    ? fileDownloadReasonMessage('host-too-old')
    : fileSaveFailureMessage('no-sink');
}
