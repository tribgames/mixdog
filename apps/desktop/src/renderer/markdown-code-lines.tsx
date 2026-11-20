import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { MarkdownBlock } from './markdown-block';
import { type BlockParking, MarkdownBlockParkingContext, UNIT_ATTRIBUTE } from './markdown-block-parking';

// A code block is one block of its reply, so the reply's parking keeps all of
// it in the DOM while any of it is near the reader (a 60k-character block held
// 28k elements, ~170 MB). Its lines are held in stretches instead, each a
// block of its own inside the card, parked like the reply's blocks.

/** Lines in one stretch: about a viewport of them. */
const STRETCH_LINES = 40;

const HASH_SEED = 0x811c9dc5;
const HASH_PRIME = 0x01000193;

function fold(hash: number, text: string): number {
  let next = hash;
  for (let at = 0; at < text.length; at++) next = Math.imul(next ^ text.charCodeAt(at), HASH_PRIME);
  return next;
}

type CodeElement = ReactElement<{ children?: ReactNode; className?: unknown }>;

export interface CodeStretch {
  children: ReactNode[];
  /** Of what the stretch renders, its text and the elements around it: a
   *  stretch that renders otherwise is another block, laid out anew. */
  hash: number;
}

interface OpenElement {
  element: CodeElement | null;
  /** What it holds of the stretch being filled. */
  children: ReactNode[];
  /** A stretch ended inside it. */
  cut: boolean;
}

/** `children` in stretches of `lines` lines, each ending after a line break.
 *  An element a stretch ends in is closed there and opened again in the next. */
export function lineStretches(children: ReactNode, lines: number): CodeStretch[] {
  const stretches: CodeStretch[] = [];
  const open: OpenElement[] = [{ element: null, children: [], cut: false }];
  let count = 0;
  let hash = HASH_SEED;

  const opened = ({ type, props }: CodeElement) => {
    hash = fold(Math.imul(hash ^ 2, HASH_PRIME), typeof type === 'string' ? type : '');
    hash = fold(Math.imul(hash ^ 3, HASH_PRIME), typeof props.className === 'string' ? props.className : '');
  };
  const close = (depth: number) => {
    const { element, children: held, cut } = open[depth];
    if (!element || (cut && held.length === 0)) return;
    // The children as one array: a line of many tokens is more of them than
    // a call takes as arguments.
    open[depth - 1].children.push(cut ? cloneElement(element, { children: held }) : element);
  };
  const end = () => {
    for (let depth = open.length - 1; depth > 0; depth--) {
      open[depth].cut = true;
      close(depth);
      open[depth] = { element: open[depth].element, children: [], cut: true };
    }
    stretches.push({ children: open[0].children, hash: hash >>> 0 });
    open[0] = { element: null, children: [], cut: false };
    count = 0;
    hash = HASH_SEED;
    for (const { element } of open) if (element) opened(element);
  };
  const text = (value: string) => {
    let from = 0;
    for (let at = 0; at < value.length; at++) {
      const code = value.charCodeAt(at);
      hash = Math.imul(hash ^ code, HASH_PRIME);
      if (code !== 10 || ++count < lines) continue;
      open[open.length - 1].children.push(value.slice(from, at + 1));
      from = at + 1;
      end();
    }
    if (from < value.length) open[open.length - 1].children.push(from === 0 ? value : value.slice(from));
  };
  const walk = (node: ReactNode) => {
    if (typeof node === 'string') text(node);
    else if (typeof node === 'number' || typeof node === 'bigint') text(String(node));
    else if (Array.isArray(node)) for (const child of node) walk(child);
    else if (isValidElement(node)) {
      const element = node as CodeElement;
      open.push({ element, children: [], cut: false });
      opened(element);
      walk(element.props.children);
      hash = Math.imul(hash ^ 1, HASH_PRIME);
      close(open.length - 1);
      open.pop();
    }
  };
  walk(children);
  if (open[0].children.length > 0 || stretches.length === 0) {
    stretches.push({ children: open[0].children, hash: hash >>> 0 });
  }
  return stretches;
}

function ParkedCodeLines({
  parking,
  place,
  className,
  children,
}: {
  parking: BlockParking;
  place: string | null;
  className?: string;
  children?: ReactNode;
}) {
  const stretches = lineStretches(children, STRETCH_LINES);
  const [lines] = useState(() => parking.inner(place));
  const code = useRef<HTMLElement>(null);
  const at = useRef(place);
  // The first and the last block of a holder never park.
  const parks = stretches.length > 2;
  useLayoutEffect(() => {
    lines.attach(parks ? code.current : null);
  }, [lines, parks]);
  useLayoutEffect(() => {
    at.current = place;
    lines.sync();
  });
  useLayoutEffect(() => () => lines.leave(at.current), [lines]);
  // The code's own class is part of what a stretch renders as.
  const mark = (fold(HASH_SEED, className ?? '') >>> 0).toString(36);
  return (
    <code ref={code} className={className} data-md-lines="">
      {stretches.map((stretch, index) => {
        const id = `${index}.${stretch.hash.toString(36)}.${mark}:0`;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: a stretch is its place in the code.
          <MarkdownBlock key={index} id={id} parking={lines}>
            <span className="markdown-code-lines" {...{ [UNIT_ATTRIBUTE]: id }}>
              {stretch.children}
            </span>
          </MarkdownBlock>
        );
      })}
    </code>
  );
}

/** A code block's `code`. In a reply whose blocks park, its lines park too.
 *  `place`: the code block's place in the reply (PLACE_PROP). */
export function MarkdownCodeLines({
  place = null,
  className,
  children,
}: {
  place?: string | null;
  className?: string;
  children?: ReactNode;
}) {
  const parking = useContext(MarkdownBlockParkingContext);
  if (!parking) return <code className={className}>{children}</code>;
  return (
    <ParkedCodeLines parking={parking} place={place} className={className}>
      {children}
    </ParkedCodeLines>
  );
}
