import { memo, useEffect, useRef, useState, type ComponentType } from 'react';

import type { MarkdownAstRoot } from './markdown-ast';
import { LatestMarkdownAstQueue, readCachedStreamingMarkdownAst } from './markdown-worker-client';
import MarkdownAstBody from './MarkdownAstBody';
import { containsFencedCodeMarkdown, MarkdownSourceFallback } from './MarkdownSourceFallback';

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

function promoteMarkdownAst(
  current: RenderedMarkdownAst | null,
  root: MarkdownAstRoot,
  parsedText: string,
  source: string
): RenderedMarkdownAst | null {
  if (current?.text === parsedText) return current;
  // Results are single-flight, but never let an older parse replace a newer
  // one if one ever lands out of order.
  if (current && current.source.length > source.length && current.source.startsWith(source)) {
    return current;
  }
  return { text: parsedText, source, root };
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
  // A cached AST is promoted while rendering, so the delta that produced it
  // commits once instead of committing the stale parse and then re-committing
  // from an effect.
  let current = rendered;
  if (parse && current?.text !== parseText) {
    const cachedRoot = readCachedStreamingMarkdownAst(parseText);
    if (cachedRoot) {
      const promoted = promoteMarkdownAst(current, cachedRoot, parseText, text);
      if (promoted !== current) {
        current = promoted;
        setRendered(promoted);
      }
    }
  }
  const exact = current?.text === parseText ? current : null;
  // While a newer parse is in flight, the last COMPLETED parse stays on
  // screen. Our parse runs in a
  // worker, so the equivalent guarantee is "the parsed source is a prefix of
  // what is on screen now" — append-only streaming keeps that true and a
  // truncation/replacement drops it back to source.
  const usable = exact ?? (current && text.startsWith(current.source) ? current : null);
  const renderedRoot = usable?.root ?? null;
  // A cold web Worker can trail the first streamed tokens by a network round
  // trip. Fenced scripts still reserve their final card/mono geometry during
  // that gap; ordinary prose stays hidden so raw Markdown markers never flash.
  const showFencedSourceFallback = !renderedRoot && containsFencedCodeMarkdown(text);

  useEffect(() => {
    // A cached AST was already promoted during render.
    if (!parse || readCachedStreamingMarkdownAst(parseText)) return;
    // The source snapshot that produced this request: the render right before
    // this effect published it, so later growth can be recognised as append.
    const source = requestedSource.current;
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
      // One landed parse, one commit.
      setRendered((latest) => promoteMarkdownAst(latest, root, parsedText, source));
    });
  }, [parse, parseText]);
  useEffect(() => () => queue.current?.dispose(), []);

  // The live tail is parsed on a paced tick, so styled markdown appears WHILE
  // the model is typing. Our worker is the pace:
  // the newest completed parse stays mounted (a few tokens behind) instead of
  // dropping the block back to source-shaped text, at settlement too. Before
  // the first result, ordinary source stays hidden: showing it even for one
  // paint creates the raw-Markdown flash this pipeline forbids. Fenced scripts
  // alone use a source projection with their final code-card grammar.
  // `parse` gates only whether NEW parses are requested. A tail past the cap
  // keeps its last completed parse on screen — falling back to source there
  // un-styled markdown that was already rendered, which is the one thing the
  // reader must never see (the projection never shows source either).
  if (usable) {
    return <MarkdownAstBody root={usable.root} copyControl={copyControl} />;
  }
  if (showFencedSourceFallback) {
    return <MarkdownSourceFallback text={text} copyControl={copyControl} />;
  }
  // A capped live tail has no pending parse to wait for.
  return parse ? <span hidden data-transcript-pending /> : null;
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
  return (
    <ParsedMarkdownBody
      text={text}
      parseText={parseText ?? text}
      parse={parse}
      copyControl={copyControl}
    />
  );
});

export default StreamingMarkdownBody;
