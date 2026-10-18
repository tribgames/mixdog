import { createElement, Fragment, memo, type ReactNode, useCallback, useMemo } from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';

import type { MarkdownAstRoot } from './markdown-ast';
import { markdownComponents, type MarkdownCopyControl } from './markdown-components';
import { applyStreamFade, type StreamFadeTimeline } from './markdown-stream-fade';

/** One fading word. Its delay is set when its element is created, from the
 *  word's start on the reply timeline: an element re-created mid-fade (a
 *  re-parse moved the word) resumes where the animation already is. The
 *  delay is never touched again, which would re-time a running animation. */
function StreamFadeWord({ 'data-fade-at': at, children }: { 'data-fade-at'?: number; children?: ReactNode }) {
  const start = Number(at);
  const place = useCallback(
    (node: HTMLElement | null) => {
      if (node) node.style.animationDelay = `${Math.round(start - performance.now())}ms`;
    },
    [start]
  );
  return createElement('mx-fade', { ref: place, 'data-stream-fade': '' }, children);
}

// A streamed token re-renders the owner while the same parse stays on screen;
// only a newly landed AST rebuilds the element tree.
export default memo(function MarkdownAstBody({
  root,
  copyControl,
  fadeTimeline = null,
  fadeChunk = '',
}: {
  root: MarkdownAstRoot;
  copyControl: MarkdownCopyControl;
  /** A streamed reply's timeline: its words fade in (markdown-stream-fade). */
  fadeTimeline?: StreamFadeTimeline | null;
  /** This body's chunk within the reply. */
  fadeChunk?: string;
}) {
  const shown = useMemo(
    () => (fadeTimeline ? applyStreamFade(root, fadeChunk, fadeTimeline, performance.now()) : null),
    [root, fadeTimeline, fadeChunk]
  );
  const base = markdownComponents(copyControl);
  let components = base;
  if (shown && shown.tags.length > 0) {
    components = { ...base };
    for (const tag of shown.tags) (components as Record<string, unknown>)[tag] = StreamFadeWord;
  }
  return toJsxRuntime((shown?.root ?? root) as never, {
    Fragment,
    jsx,
    jsxs,
    components: components as never,
    ignoreInvalidStyle: true,
    passKeys: true,
  }) as ReactNode;
});
