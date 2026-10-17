import { useEffect, useMemo, useRef, useState } from 'react';
import type { TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { toolRowRevision, uiDiffDigest } from './transcript-tool-core';

interface LoadedToolOutput {
  result?: unknown;
  rawResult?: unknown;
  uiDiff?: unknown;
}
const FULL_TOOL_OUTPUT_LIMIT = 16;
/** Outputs already fetched, newest last, so a row the virtual list remounts
 *  keeps its full text. Keyed by session, row and row revision: a text read
 *  for one revision of a row is never shown for another. */
const fullToolOutputs = new Map<string, LoadedToolOutput>();

export function resetFullToolOutputs(): void {
  fullToolOutputs.clear();
}

export interface FullToolOutput {
  /** The row with the host's uncut output and diff in place of the phone's copy. */
  item: TranscriptItem;
  /** The output was cut: the "Show full output" button is offered. */
  outputCut: boolean;
  loading: boolean;
  failed: boolean;
  /** Reads the full text from the host; null when nothing is cut or loadable. */
  load: (() => void) | null;
}

/** The host cuts a long tool output from a phone's copy of the transcript
 *  (`remoteOutputTruncated`) and sends an edit's diff as a digest
 *  (`uiDiffSummary`). `readTranscriptItem` returns the uncut text. A digest-only
 *  diff loads on its own once the row is open (`wanted`); an output waits for
 *  the button. */
export function useFullToolOutput(sessionId: string, item: TranscriptItem, wanted: boolean): FullToolOutput {
  const outputCut = typeof item.remoteOutputTruncated === 'number' && item.remoteOutputTruncated > 0;
  const diffCut = uiDiffDigest(item) !== null;
  const id = item.id == null ? '' : String(item.id);
  const revision = toolRowRevision(item);
  const key = `${sessionId}|${id}|${revision}`;
  const [state, setState] = useState<{ key: string; status: 'loading' | 'failed' } | null>(null);
  // A request answers only the revision it was made for.
  const currentKey = useRef(key);
  currentKey.current = key;
  const status = state?.key === key ? state.status : 'idle';
  const loaded = outputCut || diffCut ? fullToolOutputs.get(key) : undefined;
  const read = typeof window === 'undefined' ? undefined : window.mixdogDesktop?.readTranscriptItem;
  const merged = useMemo(() => {
    if (!loaded) return item;
    const { remoteOutputTruncated: _cut, uiDiffSummary: _digest, ...rest } = item;
    return {
      ...rest,
      ...('result' in loaded ? { result: loaded.result } : {}),
      ...('rawResult' in loaded ? { rawResult: loaded.rawResult } : {}),
      ...('uiDiff' in loaded ? { uiDiff: loaded.uiDiff } : {}),
    } as TranscriptItem;
  }, [item, loaded]);
  const load =
    (outputCut || diffCut) && !loaded && read && sessionId && id
      ? () => {
          const requested = key;
          const settle = (next: 'failed' | null) => {
            if (currentKey.current === requested) setState(next && { key: requested, status: next });
          };
          setState({ key: requested, status: 'loading' });
          void Promise.resolve(read(sessionId, id))
            .then((output) => {
              if (!output || output.withheld) {
                settle('failed');
                return;
              }
              fullToolOutputs.delete(requested);
              fullToolOutputs.set(requested, {
                ...('result' in output ? { result: output.result } : {}),
                ...('rawResult' in output ? { rawResult: output.rawResult } : {}),
                ...('uiDiff' in output ? { uiDiff: output.uiDiff } : {}),
              });
              while (fullToolOutputs.size > FULL_TOOL_OUTPUT_LIMIT) {
                fullToolOutputs.delete(fullToolOutputs.keys().next().value as string);
              }
              settle(null);
            })
            .catch(() => settle('failed'));
        }
      : null;
  const loadRef = useRef(load);
  loadRef.current = load;
  const autoLoad = wanted && diffCut && load !== null && status === 'idle';
  // \key\ re-arms the load when the row changes while it stays open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: \key\ is the trigger, not a value the effect reads
  useEffect(() => {
    if (autoLoad) loadRef.current?.();
  }, [autoLoad, key]);
  return { item: merged, outputCut, loading: status === 'loading', failed: status === 'failed', load };
}

/** "Show full output" under a cut row; "Loading…" while it reads; "Retry"
 *  when it failed. Nothing for a row that is whole (a diff that loads by
 *  itself shows only while it loads or after it failed). */
export function FullToolOutputButton({ output }: { output: FullToolOutput }) {
  if (!output.load || !(output.outputCut || output.loading || output.failed)) return null;
  return (
    <button
      type="button"
      className="tool-activity-preview-more"
      disabled={output.loading}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={output.load}
    >
      {output.loading ? t('Loading…') : output.failed ? t('Retry') : t('Show full output')}
    </button>
  );
}
