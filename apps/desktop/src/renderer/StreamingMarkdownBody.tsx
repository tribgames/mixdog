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
  root: MarkdownAstRoot;
}

const ParsedMarkdownBody = memo(function ParsedMarkdownBody({
  text,
  parseText,
  live,
  deferAsyncPromotion,
  copyControl,
}: {
  text: string;
  parseText: string;
  live: boolean;
  deferAsyncPromotion: boolean;
  copyControl: MarkdownCopyControl;
}) {
  const persistentCodeSource = isFencedCodeOnlyMarkdown(text);
  const [rendered, setRendered] = useState<RenderedMarkdownAst | null>(() => {
    if (persistentCodeSource) return null;
    const root = readCachedStreamingMarkdownAst(parseText);
    return root ? { text: parseText, root } : null;
  });
  const requestedText = useRef(parseText);
  const deferAsyncPromotionRef = useRef(deferAsyncPromotion);
  const queue = useRef<LatestMarkdownAstQueue | null>(null);
  queue.current ??= new LatestMarkdownAstQueue();
  requestedText.current = parseText;
  deferAsyncPromotionRef.current = deferAsyncPromotion;
  const exact = rendered?.text === parseText ? rendered : null;

  useEffect(() => {
    if (persistentCodeSource) return;
    const cachedRoot = readCachedStreamingMarkdownAst(parseText);
    if (cachedRoot) {
      if (!deferAsyncPromotion) {
        setRendered((current) => current?.text === parseText && current.root === cachedRoot
          ? current
          : { text: parseText, root: cachedRoot });
      }
      return;
    }
    queue.current?.request(parseText, (root, parsedText) => {
      // A live suffix is never partially promoted. Only the exact immutable
      // chunk may replace its source-shaped fallback, so worker latency cannot
      // move the AST/plain split and rewrite layout under bottom-follow.
      // A streamed fenced script keeps its current source-shaped DOM for this
      // mount. The worker still warms the AST cache, but independently arriving
      // chunk results may not rewrite one visible response row after output has
      // gone idle. A later safe remount starts rich from the warmed cache.
      if (requestedText.current === parsedText && !deferAsyncPromotionRef.current) {
        setRendered({ text: parsedText, root });
      }
    });
  }, [deferAsyncPromotion, parseText, persistentCodeSource]);
  useEffect(() => () => queue.current?.dispose(), []);

  if (!persistentCodeSource && exact) {
    return <MarkdownAstBody root={exact.root} copyControl={copyControl} />;
  }
  // OpenCode parses the live tail on every paced tick (PacedMarkdown), so
  // styled markdown appears WHILE the model is typing. Our worker is the
  // pace: while the newest slice is still parsing, keep the PREVIOUS parsed
  // AST on screen (a few tokens behind) instead of dropping the whole block
  // back to source-shaped text — that source phase read as "markdown styling
  // arrives late" during generation. Before the first worker result (or with
  // a geometry-locked fenced script) the source fallback still applies.
  if (!persistentCodeSource && live && rendered && !deferAsyncPromotion) {
    return <MarkdownAstBody root={rendered.root} copyControl={copyControl} />;
  }
  // Keep the exact source visible until this exact immutable chunk is parsed.
  return <MarkdownSourceFallback text={text} copyControl={copyControl} />;
});

const StreamingMarkdownBody = memo(function StreamingMarkdownBody({
  text,
  parseText,
  live = false,
  deferAsyncPromotion = false,
  copyControl,
}: {
  text: string;
  parseText?: string;
  live?: boolean;
  deferAsyncPromotion?: boolean;
  copyControl: MarkdownCopyControl;
}) {
  // Stable chunks promote exactly (immutable text -> exact AST). The live
  // tail renders the latest COMPLETED parse and trails the raw text by worker
  // latency, mirroring OpenCode's paced streaming markdown.
  // `parseText` is the healed form of `text` for the live tail: the parser
  // sees closed markers while the source fallback still shows exactly what
  // the model has emitted.
  return <ParsedMarkdownBody text={text} parseText={parseText ?? text} live={live}
    deferAsyncPromotion={deferAsyncPromotion} copyControl={copyControl} />;
});

export default StreamingMarkdownBody;
