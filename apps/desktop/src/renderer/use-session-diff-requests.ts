import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  consumeSessionDiffFileRequest,
  type SessionDiffFileRequest,
  sessionDiffRequestPaths,
  useSessionDiffFileRequest,
} from './session-diff-focus';
import type { SessionDiffRow } from './session-diff-model';
import { normalizeChangePath } from './turn-changes-model';
import type { useSessionDiffRefresh } from './use-session-diff-refresh';

function findRequestedRow<T extends { path: string }>(
  rows: readonly T[],
  request: SessionDiffFileRequest
): T | undefined {
  // Drive-letter and UNC paths compare case-insensitively; POSIX paths exactly.
  const windowsStyle = (path: string) => /^(?:[A-Za-z]:|\/\/)/.test(path);
  const same = (left: string, right: string) =>
    windowsStyle(left) || windowsStyle(right) ? left.toLowerCase() === right.toLowerCase() : left === right;
  for (const wanted of sessionDiffRequestPaths(request)) {
    const row = rows.find((candidate) => same(normalizeChangePath(candidate.path), wanted));
    if (row) return row;
  }
  return undefined;
}

/** Serves the requests posted to this session's pane: the island's files
 *  segment asks for every file, a transcript turn-changes card for one file.
 *  Returns the file request still pending, if any. */
export function useSessionDiffRequests({
  sessionId,
  active,
  rows,
  ready,
  error,
  refresh,
  adoptions,
  expandPath,
  showAllFiles,
  openDiffTab,
  setChangesOpen,
}: {
  sessionId: string;
  active: boolean;
  rows: readonly SessionDiffRow[];
  /** A read has answered: rows are a result, not a placeholder. */
  ready: boolean;
  error: string;
  refresh: ReturnType<typeof useSessionDiffRefresh>['refresh'];
  adoptions: number;
  expandPath(path: string): void;
  showAllFiles(): void;
  openDiffTab(path: string): void;
  setChangesOpen(open: boolean): void;
}): SessionDiffFileRequest | null {
  const pendingRequest = useSessionDiffFileRequest(active ? sessionId : '');
  // The island's files segment asks for the top of the stack.
  const listRequestSeq = pendingRequest && !pendingRequest.path ? pendingRequest.seq : 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per list request; the tab action is read at that moment
  useEffect(() => {
    if (!listRequestSeq) return;
    consumeSessionDiffFileRequest(listRequestSeq);
    showAllFiles();
  }, [listRequestSeq]);
  // A transcript turn-changes card asks for one file: re-read the diff, then
  // open that file, or say it is gone — never silently select another one.
  const fileRequest = pendingRequest?.path ? pendingRequest : null;
  const fileRequestSeq = fileRequest?.seq ?? 0;
  const [fileRequestRead, setFileRequestRead] = useState(0);
  // The file is already among the rows on screen (the cached diff "Changes"
  // paints at once): open its tab right away, as fast as "Changes"; the
  // re-read below still confirms it and refreshes its diff, or says it left.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per request; later row updates are the re-read's job
  useLayoutEffect(() => {
    if (!fileRequest) return;
    const row = findRequestedRow(rows, fileRequest);
    if (row) openDiffTab(row.path);
  }, [fileRequestSeq]);
  // A request resolves only against a result a refresh adopted after it was
  // posted. A skipped (hidden) or superseded refresh leaves the request
  // waiting for the next adopted result instead of reading stale rows.
  const adoptionsRef = useRef(adoptions);
  adoptionsRef.current = adoptions;
  const [fileRequestWait, setFileRequestWait] = useState({ seq: 0, base: 0 });
  useEffect(() => {
    if (!fileRequestSeq) return undefined;
    let stale = false;
    const base = adoptionsRef.current;
    // Not forced: it joins the signal-aware read already answering the
    // current change signal (or adopts the settled result) instead of queuing
    // a second whole-session read behind it.
    void refresh(false).then((adopted) => {
      if (stale) return;
      if (adopted) setFileRequestRead(fileRequestSeq);
      else setFileRequestWait({ seq: fileRequestSeq, base });
    });
    return () => {
      stale = true;
    };
  }, [fileRequestSeq, refresh]);
  useEffect(() => {
    if (fileRequestSeq && fileRequestWait.seq === fileRequestSeq && adoptions > fileRequestWait.base) {
      setFileRequestRead(fileRequestSeq);
    }
  }, [adoptions, fileRequestSeq, fileRequestWait]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: resolves when the request or the re-read rows change; the notice, fold and tab actions are read at that moment
  useEffect(() => {
    if (!fileRequest || fileRequestRead !== fileRequest.seq || !ready || error) return;
    consumeSessionDiffFileRequest(fileRequest.seq);
    const row = findRequestedRow(rows, fileRequest);
    if (row) {
      expandPath(row.path);
      openDiffTab(row.path);
    } else {
      // The file is gone (committed or reverted): show every file instead.
      setChangesOpen(true);
    }
  }, [fileRequest, fileRequestRead, ready, error, rows]);
  return fileRequest;
}
