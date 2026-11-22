import {
  createElement,
  Fragment,
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';

import type { MarkdownAstRoot } from './markdown-ast';
import { PLACE_PROP } from './markdown-block-parking';
import { highlightMentions, MarkdownMentionNamesContext } from './markdown-mentions';
import { markdownComponents, type MarkdownCopyControl } from './markdown-components';
import { applyStreamFade, STREAM_FADE_BOX_TAGS, type StreamFadeTimeline } from './markdown-stream-fade';

interface FadeProps {
  'data-fade-at'?: number;
  'data-fade-ms'?: number;
  children?: ReactNode;
}

/** The phrase start each element was placed for. */
const placedAt = new WeakMap<HTMLElement, number>();

function useFadePlacement(at: number | undefined, ms: number | undefined) {
  const start = Number(at);
  const duration = Number(ms);
  return useCallback(
    (node: HTMLElement | null) => {
      if (!node || !Number.isFinite(start) || placedAt.get(node) === start) return;
      placedAt.set(node, start);
      node.style.setProperty('--mx-fade-delay', `${Math.round(start - performance.now())}ms`);
      node.style.setProperty('--mx-fade-ms', `${Math.round(duration)}ms`);
    },
    [start, duration]
  );
}

/** One fading stretch of a phrase. */
function StreamFadeWord({ 'data-fade-at': at, 'data-fade-ms': ms, children }: FadeProps) {
  const place = useFadePlacement(at, ms);
  return createElement('mx-fade', { ref: place, 'data-stream-fade': '' }, children);
}

const fadeBoxes = Object.fromEntries(
  STREAM_FADE_BOX_TAGS.map((tag) => [
    tag,
    // biome-ignore lint/correctness/noComponentHookFactories: built once per tag at module load, so each stays the same component
    function StreamFadeBox({ 'data-fade-at': at, 'data-fade-ms': ms, children, ...rest }: FadeProps) {
      const place = useFadePlacement(at, ms);
      return createElement(tag, { ...rest, ref: place }, children);
    },
  ])
);

function useBodyFade(
  body: MarkdownAstRoot,
  fadeTimeline: StreamFadeTimeline | null,
  fadeOffset: number,
  fadeEnd: number | undefined,
  fadeFrom: number
) {
  // Once the last fade it shows ended the body renders again, unwrapped: no
  // wrapper outlives its fade.
  const [faded, fadeEnded] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `faded` marks the render after a fade ended.
  const fresh = useMemo(
    () => (fadeTimeline ? applyStreamFade(body, fadeOffset, fadeTimeline, performance.now(), fadeEnd, fadeFrom) : null),
    [body, fadeTimeline, fadeOffset, fadeEnd, fadeFrom, faded]
  );
  const until = fresh?.until ?? 0;
  // What this tree brings on screen starts fading as it commits; the row
  // stays live while text is still to come on screen or a body shows a fade
  // (useStreamFade).
  const holder = useRef({});
  useLayoutEffect(() => {
    if (!fadeTimeline || !fresh) return;
    fadeTimeline.appear(fresh.appearance, performance.now());
  }, [fadeTimeline, fresh]);
  useLayoutEffect(() => {
    if (!fadeTimeline) return;
    fadeTimeline.show(holder.current, until);
    return () => fadeTimeline.show(holder.current, 0);
  }, [fadeTimeline, until]);
  useEffect(() => {
    if (!until) return;
    const timer = setTimeout(() => fadeEnded((count) => count + 1), Math.max(0, until - performance.now()));
    return () => clearTimeout(timer);
  }, [until]);
  return fresh && fresh.until > 0 ? fresh : null;
}

/** How a body's text fades in: its reply's timeline, where the offsets of its
 *  tree count from in the reply, and the text of the reply it shows [from,
 *  end) (`end`: by default all revealed so far). */
export interface MarkdownAstFade {
  timeline: StreamFadeTimeline | null;
  offset: number;
  from: number;
  end: number | undefined;
}

/** `root` as React elements, fading in as `fade` says. `place`: where the
 *  tree is in a reply whose blocks park (null: they do not): each code block
 *  is told its place under it, under which what is parked of its lines is
 *  kept while the block around it is out of the DOM (markdown-code-lines). */
export function useMarkdownAst(
  root: MarkdownAstRoot,
  copyControl: MarkdownCopyControl,
  fade: MarkdownAstFade,
  place: string | null
): ReactNode {
  const mentionNames = useContext(MarkdownMentionNamesContext);
  const body = useMemo(() => (mentionNames ? highlightMentions(root, mentionNames) : root), [root, mentionNames]);
  const shown = useBodyFade(body, fade.timeline, fade.offset, fade.end, fade.from);
  // A body that faded keeps the box components once its fades ended, so
  // unwrapping never remounts its items and rows.
  const boxed = useRef(false);
  if (shown) boxed.current = true;
  const base = markdownComponents(copyControl);
  let components = base;
  if (boxed.current) components = { ...base, ...fadeBoxes };
  if (shown) for (const tag of shown.tags) (components as Record<string, unknown>)[tag] = StreamFadeWord;
  let codes = 0;
  const placed =
    (create: typeof jsx): typeof jsx =>
    (type, props, key) =>
      create(
        type,
        type === components.pre ? { ...(props as object), [PLACE_PROP]: `${place}/${codes++}` } : props,
        key
      );
  return toJsxRuntime((shown?.root ?? body) as never, {
    Fragment,
    jsx: place === null ? jsx : placed(jsx),
    jsxs: place === null ? jsxs : placed(jsxs),
    components: components as never,
    ignoreInvalidStyle: true,
    passKeys: true,
  }) as ReactNode;
}

// A streamed token re-renders the owner while the same parse stays on screen;
// only a newly landed AST rebuilds the element tree.
export default memo(function MarkdownAstBody({
  root,
  copyControl,
  fadeTimeline = null,
  fadeOffset = 0,
  fadeEnd,
}: {
  root: MarkdownAstRoot;
  copyControl: MarkdownCopyControl;
  /** A streamed reply's timeline: its text fades in (markdown-stream-fade). */
  fadeTimeline?: StreamFadeTimeline | null;
  /** Where this body's text starts in the reply. */
  fadeOffset?: number;
  /** Where the text `root` was parsed from ends in the reply (by default all
   *  of it revealed so far). */
  fadeEnd?: number;
}) {
  return useMarkdownAst(
    root,
    copyControl,
    { timeline: fadeTimeline, offset: fadeOffset, from: fadeOffset, end: fadeEnd },
    null
  );
});
