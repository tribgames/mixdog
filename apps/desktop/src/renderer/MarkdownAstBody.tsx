import {
  Children,
  cloneElement,
  createElement,
  Fragment,
  isValidElement,
  memo,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';

import type { MarkdownAstRoot } from './markdown-ast';
import { MarkdownBlock } from './markdown-block';
import { MarkdownBlockParkingContext, PLACE_PROP, UNIT_ATTRIBUTE } from './markdown-block-parking';
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

/** Times an element's fade: its delay is set when the element is created,
 *  from the reveal's start on the reply timeline, so an element re-created
 *  mid-fade (a re-parse moved it) resumes where the animation already is. It
 *  is placed again only for another start: re-timing a running animation
 *  would make it jump. */
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

/** List items, table rows, quotes, rules and inline code of a streamed reply:
 *  while one fades (`data-stream-fade-box`), its chrome fades with its first
 *  character. The component stays in place after the fade, so nothing
 *  remounts. */
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
  const mentionNames = useContext(MarkdownMentionNamesContext);
  const parking = useContext(MarkdownBlockParkingContext);
  const bodyId = useId();
  const body = useMemo(() => (mentionNames ? highlightMentions(root, mentionNames) : root), [root, mentionNames]);
  // Once the last fade it shows ended the body renders again, unwrapped: no
  // wrapper outlives its fade.
  const [faded, fadeEnded] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `faded` marks the render after a fade ended.
  const fresh = useMemo(
    () => (fadeTimeline ? applyStreamFade(body, fadeOffset, fadeTimeline, performance.now(), fadeEnd) : null),
    [body, fadeTimeline, fadeOffset, fadeEnd, faded]
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
  const shown = fresh && fresh.until > 0 ? fresh : null;
  // A body that faded keeps the box components once its fades ended, so
  // unwrapping never remounts its items and rows.
  const boxed = useRef(false);
  if (shown) boxed.current = true;
  const base = markdownComponents(copyControl);
  let components = base;
  if (boxed.current) components = { ...base, ...fadeBoxes };
  if (shown) for (const tag of shown.tags) (components as Record<string, unknown>)[tag] = StreamFadeWord;
  // A new tree is new blocks: a box measured for the former ones is dropped
  // before paint.
  const measured = useRef(body);
  useLayoutEffect(() => {
    if (measured.current !== body) parking?.release(bodyId);
    measured.current = body;
    parking?.sync();
  });
  // The body left the reply: other blocks stand next to its neighbours now.
  useLayoutEffect(() => () => parking?.sync(), [parking]);
  // And nothing is kept for its code blocks. They leave in the commit's layout
  // phase, which this cleanup comes after.
  useEffect(() => () => parking?.release(bodyId), [parking, bodyId]);
  // Each code block is told its place in the body, under which what is parked
  // of its lines is kept while the block around it is out of the DOM
  // (markdown-code-lines).
  let codes = 0;
  const placed =
    (create: typeof jsx): typeof jsx =>
    (type, props, key) =>
      create(
        type,
        type === components.pre ? { ...(props as object), [PLACE_PROP]: `${bodyId}/${codes++}` } : props,
        key
      );
  // The tree is converted once, as without parking; only its top-level
  // elements are then held one by one.
  const rendered = toJsxRuntime((shown?.root ?? body) as never, {
    Fragment,
    jsx: parking ? placed(jsx) : jsx,
    jsxs: parking ? placed(jsxs) : jsxs,
    components: components as never,
    ignoreInvalidStyle: true,
    passKeys: true,
  }) as ReactNode;
  if (!parking || !isValidElement<{ children?: ReactNode }>(rendered) || rendered.type !== Fragment) return rendered;
  // Each top-level block is its own component, so one far from the reader can
  // leave the DOM (markdown-block-parking).
  return Children.toArray(rendered.props.children).map((child, index) => {
    if (!isValidElement(child)) return child;
    const id = `${bodyId}:${index}`;
    return (
      <MarkdownBlock key={child.key} id={id} parking={parking}>
        {cloneElement(child as ReactElement<Record<string, unknown>>, { [UNIT_ATTRIBUTE]: id })}
      </MarkdownBlock>
    );
  });
});
