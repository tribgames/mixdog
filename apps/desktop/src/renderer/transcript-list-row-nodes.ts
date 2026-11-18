import type { ReactNode } from 'react';
import type { TranscriptRowModel } from './transcript-rows';

type RenderRow = (row: TranscriptRowModel, index: number, rows: readonly TranscriptRowModel[]) => ReactNode;

export const paintsNothing = (node: ReactNode) => node === null || node === undefined || node === false;

/** Each row's node and its nearest painted neighbours, computed lazily once
 *  per (`rows`, `renderRow`) identity. A row's node is a pure function of
 *  those two, so list-internal renders (a scroll moving the visible range)
 *  reuse the nodes and neighbour walks instead of rendering every mounted row
 *  and re-walking past the blank rows around it. */
export interface TranscriptRowNodes {
  nodeAt(index: number): ReactNode;
  /** The nearest row above `index` that paints, or -1. */
  paintedAbove(index: number): number;
  /** The nearest row below `index` that paints, or `rows.length`. */
  paintedBelow(index: number): number;
}

export function createTranscriptRowNodes(rows: readonly TranscriptRowModel[], renderRow: RenderRow): TranscriptRowNodes {
  const nodes = new Map<number, ReactNode>();
  const above = new Map<number, number>();
  const below = new Map<number, number>();
  const nodeAt = (index: number): ReactNode => {
    if (!nodes.has(index)) nodes.set(index, renderRow(rows[index] as TranscriptRowModel, index, rows));
    return nodes.get(index);
  };
  const paintedAbove = (index: number): number => {
    const known = above.get(index);
    if (known !== undefined) return known;
    let at = index - 1;
    // A run of blank rows resolves once: every row in it shares the answer.
    const run: number[] = [];
    while (at >= 0 && paintsNothing(nodeAt(at))) {
      const cached = above.get(at);
      if (cached !== undefined) {
        at = cached;
        break;
      }
      run.push(at);
      at -= 1;
    }
    above.set(index, at);
    for (const blank of run) above.set(blank, at);
    return at;
  };
  const paintedBelow = (index: number): number => {
    const known = below.get(index);
    if (known !== undefined) return known;
    let at = index + 1;
    const run: number[] = [];
    while (at < rows.length && paintsNothing(nodeAt(at))) {
      const cached = below.get(at);
      if (cached !== undefined) {
        at = cached;
        break;
      }
      run.push(at);
      at += 1;
    }
    below.set(index, at);
    for (const blank of run) below.set(blank, at);
    return at;
  };
  return { nodeAt, paintedAbove, paintedBelow };
}
