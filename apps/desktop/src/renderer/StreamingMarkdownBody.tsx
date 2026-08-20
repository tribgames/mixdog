import { memo, useEffect, useRef, useState, type ComponentType } from "react";

import type { MarkdownAstRoot } from "./markdown-ast";
import { MarkdownSourceFallback } from "./MarkdownSourceFallback";
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
  copyControl,
}: {
  text: string;
  parseText: string;
  parse: boolean;
  copyControl: MarkdownCopyControl;
}) {
  const [rendered, setRendered] = useState<RenderedMarkdownAst | null>(() => {
    // A cache read is free, so even a tail past the parse cap opens styled
    // when the worker already holds its AST.
    const root = readCachedStreamingMarkdownAst(parseText);
    return root ? { text: parseText, source: text, root } : null;
  });
  const requestedText = useRef(parseText);
  const requestedSource = useRef(text);
  const queue = useRef<LatestMarkdownAstQueue | null>(null);
  queue.current ??= new LatestMarkdownAstQueue();
  requestedText.current = parseText;
  requestedSource.current = text;
  const exact = rendered?.text === parseText ? rendered : null;
  // While a newer parse is in flight, the last COMPLETED parse stays on
  // screen. Our parse runs in a
  // worker, so the equivalent guarantee is "the parsed source is a prefix of
  // what is on screen now" — append-only streaming keeps that true and a
  // truncation/replacement drops it back to source.
  const usable = exact
    ?? (rendered && text.startsWith(rendered.source) ? rendered : null);

  useEffect(() => {
    if (!parse) return;
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
      promote(cachedRoot, parseText);
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
      if (requestedText.current !== parsedText && !requestedSource.current.startsWith(source)) {
        return;
      }
      promote(root, parsedText);
    });
  }, [parse, parseText]);
  useEffect(() => () => queue.current?.dispose(), []);

  // The live tail is parsed on a paced tick, so styled markdown appears WHILE
  // the model is typing. Our worker is the pace:
  // the newest completed parse stays mounted (a few tokens behind) instead of
  // dropping the block back to source-shaped text, at settlement too. Before
  // the first result, or for a tail too large to reparse per frame, the source
  // fallback still applies.
  // `parse` gates only whether NEW parses are requested. A tail past the cap
  // keeps its last completed parse on screen — falling back to source there
  // un-styled markdown that was already rendered, which is the one thing the
  // reader must never see (the projection never shows source either).
  if (usable) {
    return <MarkdownAstBody root={usable.root} copyControl={copyControl} />;
  }
  return <MarkdownSourceFallback text={text} copyControl={copyControl} />;
});

const StreamingMarkdownBody = memo(function StreamingMarkdownBody({
  text,
  parseText,
  parse = true,
  copyControl,
}: {
  text: string;
  parseText?: string;
  parse?: boolean;
  copyControl: MarkdownCopyControl;
}) {
  // Stable chunks promote exactly (immutable text -> exact AST, whose source
  // never changes). The live tail renders the latest COMPLETED parse and
  // trails the raw text by worker latency (paced streaming markdown).
  // `parseText` is the healed form of `text` for the live tail: the parser
  // sees closed markers while the source fallback still shows exactly what
  // the model has emitted.
  return <ParsedMarkdownBody text={text} parseText={parseText ?? text} parse={parse}
    copyControl={copyControl} />;
});

export default StreamingMarkdownBody;
