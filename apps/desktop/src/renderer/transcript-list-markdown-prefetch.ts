import { useEffect } from 'react';
import { prefetchMarkdownAsts } from './markdown-worker-client';
import type { TranscriptRowModel } from './transcript-rows';
import { TRANSCRIPT_VIRTUAL_OVERSCAN } from './transcript-virtual-cache';

/** Rows past the mounted overscan, per side, whose replies are parsed ahead. */
const PREFETCH_ROWS = 12;

/** The exact text a settled reply's row parses (transcript-row's
 *  MarkdownResponse renders a settled reply as the parse of `item.text`). */
function settledReplyText(row: TranscriptRowModel | undefined): string {
  if (row?._tag !== 'AssistantPart') return '';
  const item = row.item;
  if (item.kind !== 'assistant' || item.streaming) return '';
  return String(item.text || '');
}

/** Parses settled replies just beyond the mounted range in the parser worker, so they mount from the cache. */
export function useMarkdownPrefetch(rows: readonly TranscriptRowModel[], startIndex: number, endIndex: number): void {
  useEffect(() => {
    if (startIndex < 0 || endIndex < startIndex) return;
    const texts: string[] = [];
    for (let step = 1; step <= TRANSCRIPT_VIRTUAL_OVERSCAN + PREFETCH_ROWS; step += 1) {
      for (const index of [endIndex + step, startIndex - step]) {
        const text = settledReplyText(rows[index]);
        if (text) texts.push(text);
      }
    }
    prefetchMarkdownAsts(texts);
  }, [rows, startIndex, endIndex]);
}
