import { SquareTerminal } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import type { TranscriptItem } from './desktop-types';
import { t } from './i18n';
import {
  onTerminalCommandAvailabilityChanged,
  revealSessionTerminalTab,
  terminalCommandRequestsAvailable,
} from './terminal-command-request';
import { desktopToolActivityTerminalRuns } from './transcript-tool-core';

const DRAFT_SESSION = 'new-task';

/** One line per `terminal` run of a tool group. Hidden where no dock can be
 *  revealed (a draft with no session). */
export function TerminalPeekLines({ items, sessionId }: { items: readonly TranscriptItem[]; sessionId: string }) {
  const available = useSyncExternalStore(
    onTerminalCommandAvailabilityChanged,
    terminalCommandRequestsAvailable,
    terminalCommandRequestsAvailable
  );
  const runs = desktopToolActivityTerminalRuns(items);
  if (!runs.length || !sessionId || sessionId === DRAFT_SESSION || !available) return null;
  return (
    <>
      {runs.map((run) => (
        <button
          key={run.id}
          type="button"
          className="transcript-browser-peek transcript-terminal-peek"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => revealSessionTerminalTab(sessionId, run.terminalId)}
        >
          <SquareTerminal size={14} aria-hidden="true" />
          <span>{t('Terminal')}</span>
          <span aria-hidden="true">·</span>
          <code className="transcript-terminal-peek-command" title={run.command}>
            {run.command}
          </code>
          <span aria-hidden="true">·</span>
          <b>{t('View')}</b>
        </button>
      ))}
    </>
  );
}
