// Explorer entry mutations: the file operations the Files pane runs on a
// selection — recycle-bin delete and the copy/move transfer shared by paste and
// drag-and-drop — plus the naming a nested "a/b/c" creation resolves to. The
// IPC and the retry bookkeeping live here; the pane keeps the selection,
// expansion and error surfacing that follow a mutation.
import type { DesktopApi } from '../shared/contract';
import { explorerChildRel, explorerParentRel } from './explorer-tree-model';

/** Raw failure text. The explorer deliberately shows the message the main
 *  process sent (the offending path, the permission detail) instead of
 *  ErrorNotice's stripped summary. */
export function explorerErrorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** Outcome of a multi-entry mutation: what survived to be retried, and the
 *  failure the pane reports (the first one — later ones repeat the cause). */
interface ExplorerBatchResult {
  failed: string[];
  firstError?: unknown;
}

interface ExplorerEntryRequest {
  api: DesktopApi | undefined;
  projectPath: string;
  rels: readonly string[];
}

/** Entries a copy/move may actually touch: never onto itself, never into its
 *  own subtree, and a move into the folder an entry already lives in is a
 *  no-op (a copy there is not — it makes the "name copy" duplicate). */
export function explorerTransferRels(rels: readonly string[], targetDirRel: string, copy: boolean): string[] {
  return rels.filter(
    (rel) =>
      targetDirRel !== rel && !targetDirRel.startsWith(`${rel}/`) && (copy || explorerParentRel(rel) !== targetDirRel)
  );
}

/** Copy/move into `targetDirRel`, one entry at a time so the main process
 *  never races two file operations over the same tree. */
export async function transferExplorerEntries(
  request: ExplorerEntryRequest & { targetDirRel: string; copy: boolean }
): Promise<ExplorerBatchResult> {
  const { api, projectPath, rels, targetDirRel, copy } = request;
  const failed: string[] = [];
  let firstError: unknown;
  for (const rel of rels) {
    try {
      if (copy) await api?.copyProjectEntry?.(projectPath, rel, targetDirRel);
      else await api?.moveProjectEntry?.(projectPath, rel, targetDirRel);
    } catch (reason) {
      failed.push(rel);
      firstError ??= reason;
    }
  }
  return { failed, firstError };
}

/** Recycle-bin delete of a whole selection: every entry is attempted, so one
 *  locked file never keeps the rest of the selection on disk. */
export async function trashExplorerEntries(request: ExplorerEntryRequest): Promise<ExplorerBatchResult> {
  const { api, projectPath, rels } = request;
  const results = await Promise.allSettled(
    rels.map((rel) => Promise.resolve(api?.trashProjectEntry?.(projectPath, rel)))
  );
  const rejection = results.find((result) => result.status === 'rejected');
  return {
    failed: results.flatMap((result, index) => (result.status === 'rejected' ? [rels[index]] : [])),
    firstError: rejection?.status === 'rejected' ? rejection.reason : undefined,
  };
}

/** Where a created name lands: the entry itself is the last segment, and a
 *  nested "a/b/c" name also reveals every folder it introduced on the way. */
export function explorerCreatedEntry(
  parentRel: string,
  name: string,
  dir: boolean
): {
  finalRel: string;
  expandRels: string[];
} {
  const segments = name.split(/[\\/]/).filter(Boolean);
  const expandRels: string[] = [];
  let cursor = parentRel;
  for (const segment of dir ? segments : segments.slice(0, -1)) {
    cursor = explorerChildRel(cursor, segment);
    expandRels.push(cursor);
  }
  return { finalRel: [parentRel, ...segments].filter(Boolean).join('/'), expandRels };
}
