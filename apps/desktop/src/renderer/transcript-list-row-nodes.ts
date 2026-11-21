import type { ReactNode } from 'react';
import type { TranscriptRowModel } from './transcript-rows';

type RenderRow = (row: TranscriptRowModel, index: number, rows: readonly TranscriptRowModel[]) => ReactNode;

export const paintsNothing = (node: ReactNode) => node === null || node === undefined || node === false;

/** Each row's node and its nearest painted neighbours, computed lazily once
 *  per (`rows`, `renderRow`) identity. */
export interface TranscriptRowNodes {
  nodeAt(index: number): ReactNode;
  /** The nearest row above `index` that paints, or -1. */
  paintedAbove(index: number): number;
  /** The nearest row below `index` that paints, or `rows.length`. */
  paintedBelow(index: number): number;
}

export function createTranscriptRowNodes(
  rows: readonly TranscriptRowModel[],
  renderRow: RenderRow
): TranscriptRowNodes {
  const nodes = new Map<number, ReactNode>();
  const above = new Map<number, number>();
  const below = new Map<number, number>();
  const nodeAt = (index: number): ReactNode => {
    if (!nodes.has(index)) nodes.set(index, renderRow(rows[index] as TranscriptRowModel, index, rows));
    return nodes.get(index);
  };
  const paintedFrom = (cache: Map<number, number>, index: number, step: 1 | -1): number => {
    const known = cache.get(index);
    if (known !== undefined) return known;
    let at = index + step;
    const run: number[] = [];
    while (at >= 0 && at < rows.length && paintsNothing(nodeAt(at))) {
      const cached = cache.get(at);
      if (cached !== undefined) {
        at = cached;
        break;
      }
      run.push(at);
      at += step;
    }
    cache.set(index, at);
    for (const blank of run) cache.set(blank, at);
    return at;
  };
  const paintedAbove = (index: number): number => paintedFrom(above, index, -1);
  const paintedBelow = (index: number): number => paintedFrom(below, index, 1);
  return { nodeAt, paintedAbove, paintedBelow };
}
