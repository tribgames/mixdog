import { CircleX, SquareTerminal } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { BrowserPeekLine } from './browser-peek-line';
import { t } from './i18n';
import { carriedFrom } from './list-carry';
import { revealSessionTerminalTab } from './terminal-command-request';
import { timeMs } from './transcript-primitives';
import type { TranscriptRowModel } from './transcript-rows';

export type ChildSurfacePeek = {
  childSessionId: string;
  /** How the owner names the child (its pool title or tag, else its catalog title). */
  childName: string;
  surface: 'browser' | 'terminal';
  /** The page or terminal title, when the reveal named it. */
  title: string;
  /** The browser page or terminal tab the reveal opened, when it named one. */
  tabId: string;
  /** Why the open failed; '' for an open that succeeded. */
  failed: string;
  /** When the reveal arrived (ms): where the line sits in the transcript. */
  at: number;
};

const NO_PEEKS: readonly ChildSurfacePeek[] = [];
const peeksByOwner = new Map<string, readonly ChildSurfacePeek[]>();
const listeners = new Set<() => void>();
/** Which child surfaces a toggle may still open, by the order of their latest
 *  reveal (a line keeps its first `at` for placement; this moves on every
 *  reveal). A deleted child's surfaces leave it; their lines stay as history. */
const revealOrder = new Map<string, number>();
let revealSeq = 0;
const surfaceKey = (childSessionId: string, surface: ChildSurfacePeek['surface']) =>
  `${surface}\u0000${childSessionId}`;

const sameSurface = (childSessionId: string, surface: ChildSurfacePeek['surface']) => (entry: ChildSurfacePeek) =>
  entry.childSessionId === childSessionId && entry.surface === surface;

/** The conversation holding a child surface's line, and the line. */
function lineOf(childSessionId: string, surface: ChildSurfacePeek['surface']) {
  const same = sameSurface(childSessionId, surface);
  for (const [owner, peeks] of peeksByOwner) {
    const peek = peeks.find(same);
    if (peek) return { owner, peek };
  }
  return null;
}

/** One line per child surface, in `ownerSessionId`: a later reveal of the
 *  same child surface updates its line at the moment it first appeared (a
 *  "보기" press reveals through the same path and must not move it), and
 *  takes it along when it goes to another conversation. */
export function recordChildSurfacePeek(ownerSessionId: string, peek: ChildSurfacePeek): void {
  if (!ownerSessionId || !peek.childSessionId || ownerSessionId === peek.childSessionId) return;
  revealSeq += 1;
  revealOrder.set(surfaceKey(peek.childSessionId, peek.surface), revealSeq);
  const same = sameSurface(peek.childSessionId, peek.surface);
  const found = lineOf(peek.childSessionId, peek.surface);
  const next = found ? { ...peek, at: found.peek.at } : peek;
  if (found?.owner === ownerSessionId && JSON.stringify(found.peek) === JSON.stringify(next)) return;
  if (found && found.owner !== ownerSessionId) {
    peeksByOwner.set(
      found.owner,
      (peeksByOwner.get(found.owner) ?? NO_PEEKS).filter((entry) => !same(entry))
    );
  }
  const current = peeksByOwner.get(ownerSessionId) ?? NO_PEEKS;
  peeksByOwner.set(ownerSessionId, [...current.filter((entry) => !same(entry)), next]);
  for (const listener of [...listeners]) listener();
}

/** The page of the latest successful child browser open routed into
 *  `ownerSessionId`: what a conversation with no browser of its own (a room
 *  log) shows from its own Browser toggle. Null when none was routed there. */
export function latestChildBrowserPage(
  ownerSessionId: string
): { ownerSessionId: string; ownerName: string; tabId: string } | null {
  let latest: ChildSurfacePeek | null = null;
  let latestOrder = 0;
  for (const peek of childSurfacePeeksOf(ownerSessionId)) {
    if (peek.surface !== 'browser' || peek.failed || !peek.tabId) continue;
    const order = revealOrder.get(surfaceKey(peek.childSessionId, peek.surface)) ?? 0;
    if (order > latestOrder) {
      latest = peek;
      latestOrder = order;
    }
  }
  return latest ? { ownerSessionId: latest.childSessionId, ownerName: latest.childName, tabId: latest.tabId } : null;
}

/** A deleted child: no toggle may open its surfaces again (its lines stay). */
export function forgetChildSurfacePages(childSessionId: string): void {
  revealOrder.delete(surfaceKey(childSessionId, 'browser'));
  revealOrder.delete(surfaceKey(childSessionId, 'terminal'));
  if (peeksByOwner.delete(childSessionId)) for (const listener of [...listeners]) listener();
}

/** `ownerSessionId`'s child lines, in reveal order. */
export function childSurfacePeeksOf(ownerSessionId: string): readonly ChildSurfacePeek[] {
  return peeksByOwner.get(ownerSessionId) ?? NO_PEEKS;
}

/** A deferred reveal routed into `ownerSessionId` (a nearer conversation of
 *  the chain came on screen): the child's line follows it there, in place. */
export function moveChildSurfacePeek(
  childSessionId: string,
  surface: ChildSurfacePeek['surface'],
  ownerSessionId: string
): void {
  const found = lineOf(childSessionId, surface);
  if (found && found.owner !== ownerSessionId) recordChildSurfacePeek(ownerSessionId, found.peek);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useChildSurfacePeeks(ownerSessionId: string): readonly ChildSurfacePeek[] {
  const read = () => childSurfacePeeksOf(ownerSessionId);
  return useSyncExternalStore(subscribe, read, read);
}

/** When a row was recorded (ms); 0 for rows without a time of their own. */
function rowTime(row: TranscriptRowModel): number {
  if (row._tag === 'ToolActivity') return timeMs(row.items[0]?.startedAt ?? row.items[0]?.at);
  return 'item' in row && row.item ? timeMs(row.item.at ?? row.item.startedAt) : 0;
}

/** Per row list, the first row recorded after each reveal time asked of it (-1: none). */
const laterRows = new WeakMap<readonly TranscriptRowModel[], Map<number, number>>();

/** The first row recorded after `at`. Rows carried on from ones already asked (list-carry.ts) are read from the first
 *  that changed: the rows left in place hold the row found before, or none after `at`. */
function firstRowAfter(rows: readonly TranscriptRowModel[], at: number): number {
  let found = laterRows.get(rows);
  if (!found) {
    found = new Map();
    laterRows.set(rows, found);
  }
  let later = found.get(at);
  if (later !== undefined) return later;
  const made = carriedFrom(rows);
  const before = made ? laterRows.get(made.prior as readonly TranscriptRowModel[])?.get(at) : undefined;
  if (made && before !== undefined && before >= 0 && before < made.kept) later = before;
  else {
    later = -1;
    for (let index = made && before !== undefined ? made.kept : 0; index < rows.length; index += 1) {
      if (rowTime(rows[index]) <= at) continue;
      later = index;
      break;
    }
  }
  found.set(at, later);
  return later;
}

/** The row a line revealed at `at` follows: the last row recorded before it
 *  (ahead of the gap that opens the next turn), else the transcript's last. */
function childSurfacePeekRow(rows: readonly TranscriptRowModel[], at: number): number {
  const later = firstRowAfter(rows, at);
  let index = later < 0 ? rows.length - 1 : later - 1;
  if (index > 0 && rows[index]?._tag === 'TurnGap') index -= 1;
  return Math.max(0, index);
}

/** The lines `rows[index]` carries below itself. */
export function childSurfacePeeksAt(
  rows: readonly TranscriptRowModel[],
  index: number,
  peeks: readonly ChildSurfacePeek[]
): readonly ChildSurfacePeek[] {
  if (!peeks.length) return NO_PEEKS;
  const placed = peeks.filter((peek) => childSurfacePeekRow(rows, peek.at) === index);
  return placed.length ? placed : NO_PEEKS;
}

/** `sessionId`: the owner conversation showing the line. */
function ChildSurfacePeekLine({ sessionId, peek }: { sessionId: string; peek: ChildSurfacePeek }) {
  if (peek.failed) {
    return (
      <div className="transcript-surface-open-failed" role="status">
        <CircleX size={13} aria-hidden="true" />
        <span>{t('Could not open · {{reason}}', { reason: peek.failed })}</span>
      </div>
    );
  }
  if (peek.surface === 'browser') {
    return (
      <BrowserPeekLine
        sessionId={sessionId}
        page={{
          tabId: peek.tabId,
          title: peek.title,
          url: '',
          ownerSessionId: peek.childSessionId,
          ownerName: peek.childName,
        }}
      />
    );
  }
  return (
    <button
      type="button"
      className="transcript-browser-peek transcript-terminal-peek"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => revealSessionTerminalTab(peek.childSessionId, peek.tabId || undefined)}
    >
      <SquareTerminal size={14} aria-hidden="true" />
      <span>{t('Terminal')}</span>
      {peek.childName ? (
        <>
          <span aria-hidden="true">·</span>
          <span className="transcript-browser-peek-owner">{peek.childName}</span>
        </>
      ) : null}
      {peek.title ? (
        <>
          <span aria-hidden="true">·</span>
          <span className="transcript-browser-peek-title">{peek.title}</span>
        </>
      ) : null}
      <span aria-hidden="true">·</span>
      <b>{t('View')}</b>
    </button>
  );
}

/** `sessionId`: the owner conversation the lines sit in. */
export function ChildSurfacePeekLines({ sessionId, peeks }: { sessionId: string; peeks: readonly ChildSurfacePeek[] }) {
  return (
    <div className="transcript-child-surface-peeks">
      {peeks.map((peek) => (
        <ChildSurfacePeekLine key={`${peek.surface}:${peek.childSessionId}`} sessionId={sessionId} peek={peek} />
      ))}
    </div>
  );
}
