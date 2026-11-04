// A paired device's visualize snapshot leaves inline sources out
// (`inline.deferred`, see withDeferredInline): a pane reads its source from
// the host when it is shown. One read per tab revision and pane; a newer
// revision's push carries the source again or is read anew.
import { useEffect, useState } from 'react';

import type { VisualizeInlineContent, VisualizePaneView } from '../shared/visualize';

type ReadInline = (sessionId: string, tabId: string, index: number) => Promise<VisualizeInlineContent>;

/** Reads kept per session/tab/revision/pane; a failed read is dropped so the
 *  next showing asks again. */
const MAX_KEPT = 32;
const reads = new Map<string, Promise<VisualizeInlineContent>>();

export function visualizeInlineDeferred(pane: Pick<VisualizePaneView, 'inline'>): boolean {
  return pane.inline?.deferred === true;
}

/** The pane's inline content with its source, read from the host when the
 *  snapshot left it out. */
export function readVisualizeInlineBody(
  pane: VisualizePaneView,
  at: { sessionId: string; tabId: string; revision: number; index: number },
  read: ReadInline | undefined = globalThis.window?.mixdogDesktop?.visualizePaneInline
): Promise<VisualizeInlineContent> {
  if (!pane.inline) return Promise.reject(new Error('This visualize pane has no inline content.'));
  if (!visualizeInlineDeferred(pane)) return Promise.resolve(pane.inline);
  if (!read) return Promise.reject(new Error('Source unavailable'));
  const key = [at.sessionId, at.tabId, at.revision, at.index].join('\0');
  const kept = reads.get(key);
  if (kept) return kept;
  const next = read(at.sessionId, at.tabId, at.index);
  reads.set(key, next);
  next.catch(() => {
    if (reads.get(key) === next) reads.delete(key);
  });
  while (reads.size > MAX_KEPT) reads.delete(reads.keys().next().value as string);
  return next;
}

/** `pane` with its inline source in place: the pane itself when nothing was
 *  left out, null while the read runs, or the read's error. */
export function useVisualizeInlinePane(
  pane: VisualizePaneView,
  at: { sessionId: string; tabId: string; revision: number; index: number }
): { pane: VisualizePaneView | null; error: string } {
  const deferred = visualizeInlineDeferred(pane);
  const [loaded, setLoaded] = useState<{ key: string; pane: VisualizePaneView | null; error: string }>({
    key: '',
    pane: null,
    error: '',
  });
  const key = [at.sessionId, at.tabId, at.revision, at.index].join('\0');
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the pane's identity (key) and whether it was left out
  useEffect(() => {
    if (!deferred) return undefined;
    let alive = true;
    readVisualizeInlineBody(pane, at).then(
      (inline) => alive && setLoaded({ key, pane: { ...pane, inline }, error: '' }),
      (reason: unknown) =>
        alive && setLoaded({ key, pane: null, error: reason instanceof Error ? reason.message : String(reason) })
    );
    return () => {
      alive = false;
    };
  }, [key, deferred]);
  if (!deferred) return { pane, error: '' };
  return loaded.key === key ? { pane: loaded.pane, error: loaded.error } : { pane: null, error: '' };
}

/** Test seam: forget every read. */
export function resetVisualizeInlineBodies(): void {
  reads.clear();
}
