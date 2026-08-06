import { memo, useEffect, useRef, useState, type ComponentType } from "react";

import type { MarkdownAstRoot } from "./markdown-ast";
import {
  isFencedCodeOnlyMarkdown,
  MarkdownSourceFallback,
} from "./MarkdownSourceFallback";
import {
  LatestMarkdownAstQueue,
  readCachedStreamingMarkdownAst,
} from "./markdown-worker-client";
import MarkdownAstBody from "./MarkdownAstBody";

type MarkdownCopyControl = ComponentType<{
  value: string;
  label: string;
  className: string;
}>;

interface RenderedMarkdownAst {
  text: string;
  source: string;
  root: MarkdownAstRoot;
}

const ParsedMarkdownBody = memo(function ParsedMarkdownBody({
  text,
  parseText,
  parse,
  deferAsyncPromotion,
  copyControl,
}: {
  text: string;
  parseText: string;
  parse: boolean;
  deferAsyncPromotion: boolean;
  copyControl: MarkdownCopyControl;
}) {
  const persistentCodeSource = isFencedCodeOnlyMarkdown(text);
  const [rendered, setRendered] = useState<RenderedMarkdownAst | null>(() => {
    if (persistentCodeSource || !parse) return null;
    const root = readCachedStreamingMarkdownAst(parseText);
    return root ? { text: parseText, source: text, root } : null;
  });
  const requestedText = useRef(parseText);
  const requestedSource = useRef(text);
  const deferAsyncPromotionRef = useRef(deferAsyncPromotion);
  const queue = useRef<LatestMarkdownAstQueue | null>(null);
  queue.current ??= new LatestMarkdownAstQueue();
  requestedText.current = parseText;
  requestedSource.current = text;
  deferAsyncPromotionRef.current = deferAsyncPromotion;
  const exact = rendered?.text === parseText ? rendered : null;
  // While a newer parse is in flight, the last COMPLETED parse stays on
  // screen. Our parse runs in a
  // worker, so the equivalent guarantee is "the parsed source is a prefix of
  // what is on screen now" — append-only streaming keeps that true and a
  // truncation/replacement drops it back to source.
  const usable = exact
    ?? (rendered && !deferAsyncPromotion && text.startsWith(rendered.source) ? rendered : null);

  useEffect(() => {
    if (persistentCodeSource || !parse) return;
    // The source snapshot that produced this request: the render right before
    // this effect published it, so later growth can be recognised as append.
    const source = requestedSource.current;
    const promote = (root: MarkdownAstRoot, parsedText: string) => {
      setRendered((current) => {
        if (current?.text === parsedText) return current;
        // Results are single-flight, but never let an older parse replace a
        // newer one if one ever lands out of order.
        if (current && current.source.length > source.length
          && current.source.startsWith(source)) {
          return current;
        }
        return { text: parsedText, source, root };
      });
    };
    const cachedRoot = readCachedStreamingMarkdownAst(parseText);
    if (cachedRoot) {
      if (!deferAsyncPromotion) promote(cachedRoot, parseText);
      return;
    }
    queue.current?.request(parseText, (root, parsedText) => {
      // Requiring an EXACT match here meant that whenever the worker was
      // slower than the 20 Hz publication cadence every result was discarded,
      // so the live tail kept its raw "**"/"`" markers for the whole stream
      // and only styled itself once output stopped (user: 문장이 완성되기
      // 전까지 마크다운 포맷이 적용 안 된다). A result whose source is still a
      // prefix of the current text is promoted instead, exactly like
      // the last completed parse.
      // A streamed fenced script keeps its current source-shaped DOM for this
      // mount. The worker still warms the AST cache, but independently arriving
      // chunk results may not rewrite one visible response row after output has
      // gone idle. A later safe remount starts rich from the warmed cache.
      if (deferAsyncPromotionRef.current) return;
      if (requestedText.current !== parsedText && !requestedSource.current.startsWith(source)) {
        return;
      }
      promote(root, parsedText);
    });
  }, [deferAsyncPromotion, parse, parseText, persistentCodeSource]);
  useEffect(() => () => queue.current?.dispose(), []);

  // The live tail is parsed on a paced tick, so styled markdown appears WHILE
  // the model is typing. Our worker is the pace:
  // the newest completed parse stays mounted (a few tokens behind) instead of
  // dropping the block back to source-shaped text, at settlement too. Before
  // the first result, with a geometry-locked fenced script, or for a tail too
  // large to reparse per frame, the source fallback still applies.
  if (!persistentCodeSource && parse && usable) {
    return <MarkdownAstBody root={usable.root} copyControl={copyControl} />;
  }
  return <MarkdownSourceFallback text={text} copyControl={copyControl} />;
});

const StreamingMarkdownBody = memo(function StreamingMarkdownBody({
  text,
  parseText,
  parse = true,
  deferAsyncPromotion = false,
  copyControl,
}: {
  text: string;
  parseText?: string;
  parse?: boolean;
  deferAsyncPromotion?: boolean;
  copyControl: MarkdownCopyControl;
}) {
  // Stable chunks promote exactly (immutable text -> exact AST, whose source
  // never changes). The live tail renders the latest COMPLETED parse and
  // trails the raw text by worker latency (paced streaming markdown).
  // `parseText` is the healed form of `text` for the live tail: the parser
  // sees closed markers while the source fallback still shows exactly what
  // the model has emitted.
  return <ParsedMarkdownBody text={text} parseText={parseText ?? text} parse={parse}
    deferAsyncPromotion={deferAsyncPromotion} copyControl={copyControl} />;
});

export default StreamingMarkdownBody;
