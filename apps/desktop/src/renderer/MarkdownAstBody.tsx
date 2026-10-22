import { createElement, Fragment, memo, type ReactNode, useCallback, useContext, useMemo, useRef } from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';

import type { MarkdownAstRoot } from './markdown-ast';
import { highlightMentions, MarkdownMentionNamesContext } from './markdown-mentions';
import { markdownComponents, type MarkdownCopyControl } from './markdown-components';
import { applyStreamFade, STREAM_FADE_BOX_TAGS, type StreamFadeTimeline } from './markdown-stream-fade';

interface FadeProps {
  'data-fade-at'?: number;
  'data-fade-ms'?: number;
  children?: ReactNode;
}

/** Times an element's fade: its delay is set when the element is created,
 *  from the reveal's start on the reply timeline, so an element re-created
 *  mid-fade (a re-parse moved it) resumes where the animation already is. It
 *  is never touched again, which would re-time a running animation. */
function useFadePlacement(at: number | undefined, ms: number | undefined) {
  const start = Number(at);
  const duration = Number(ms);
  return useCallback(
    (node: HTMLElement | null) => {
      if (!node || !Number.isFinite(start)) return;
      node.style.setProperty('--mx-fade-delay', `${Math.round(start - performance.now())}ms`);
      node.style.setProperty('--mx-fade-ms', `${duration}ms`);
    },
    [start, duration]
  );
}

/** One fading word. */
function StreamFadeWord({ 'data-fade-at': at, 'data-fade-ms': ms, children }: FadeProps) {
  const place = useFadePlacement(at, ms);
  return createElement('mx-fade', { ref: place, 'data-stream-fade': '' }, children);
}

/** List items, table rows, quotes, rules and inline code of a streamed reply:
 *  while one fades (`data-stream-fade-box`), its chrome fades with its first
 *  word. The component stays in place after the fade, so nothing remounts. */
const fadeBoxes = Object.fromEntries(
  STREAM_FADE_BOX_TAGS.map((tag) => [
    tag,
    function StreamFadeBox({ 'data-fade-at': at, 'data-fade-ms': ms, children, ...rest }: FadeProps) {
      const place = useFadePlacement(at, ms);
      return createElement(tag, { ...rest, ref: place }, children);
    },
  ])
);

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
  const mentionNames = useContext(MarkdownMentionNamesContext);
  const body = useMemo(() => (mentionNames ? highlightMentions(root, mentionNames) : root), [root, mentionNames]);
  const shown = useMemo(
    () => (fadeTimeline ? applyStreamFade(body, fadeChunk, fadeTimeline, performance.now()) : null),
    [body, fadeTimeline, fadeChunk]
  );
  // A body that faded keeps the box components once its timeline is gone, so
  // settling unwraps its words without remounting its items and rows.
  const faded = useRef(false);
  if (shown) faded.current = true;
  const base = markdownComponents(copyControl);
  let components = base;
  if (faded.current) components = { ...base, ...fadeBoxes };
  if (shown) for (const tag of shown.tags) (components as Record<string, unknown>)[tag] = StreamFadeWord;
  return toJsxRuntime((shown?.root ?? body) as never, {
    Fragment,
    jsx,
    jsxs,
    components: components as never,
    ignoreInvalidStyle: true,
    passKeys: true,
  }) as ReactNode;
});
