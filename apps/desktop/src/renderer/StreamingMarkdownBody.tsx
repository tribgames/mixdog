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
  live,
  deferAsyncPromotion,
  copyControl,
}: {
  text: string;
  live: boolean;
  deferAsyncPromotion: boolean;
  copyControl: MarkdownCopyControl;
}) {
  const persistentCodeSource = isFencedCodeOnlyMarkdown(text);
  const [rendered, setRendered] = useState<RenderedMarkdownAst | null>(() => {
    if (persistentCodeSource) return null;
    const root = readCachedStreamingMarkdownAst(text);
    return root ? { text, root } : null;
  });
  const requestedText = useRef(text);
  const deferAsyncPromotionRef = useRef(deferAsyncPromotion);
  const queue = useRef<LatestMarkdownAstQueue | null>(null);
  queue.current ??= new LatestMarkdownAstQueue();
  requestedText.current = text;
  deferAsyncPromotionRef.current = deferAsyncPromotion;
  const exact = rendered?.text === text ? rendered : null;

  useEffect(() => {
    if (persistentCodeSource) return;
    const cachedRoot = readCachedStreamingMarkdownAst(text);
    if (cachedRoot) {
      if (!deferAsyncPromotion) {
        setRendered((current) => current?.text === text && current.root === cachedRoot
          ? current
          : { text, root: cachedRoot });
      }
      return;
    }
    queue.current?.request(text, (root, parsedText) => {
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
  }, [deferAsyncPromotion, persistentCodeSource, text]);
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
  live = false,
  deferAsyncPromotion = false,
  copyControl,
}: {
  text: string;
  live?: boolean;
  deferAsyncPromotion?: boolean;
  copyControl: MarkdownCopyControl;
}) {
  // Stable chunks promote exactly (immutable text -> exact AST). The live
  // tail renders the latest COMPLETED parse and trails the raw text by worker
  // latency, mirroring OpenCode's paced streaming markdown.
  return <ParsedMarkdownBody text={text} live={live}
    deferAsyncPromotion={deferAsyncPromotion} copyControl={copyControl} />;
});

export default StreamingMarkdownBody;
