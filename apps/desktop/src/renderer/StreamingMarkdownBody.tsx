import { memo, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';

import type { MarkdownAstRoot } from './markdown-ast';
import {
  LatestMarkdownAstQueue,
  parseSettledMarkdownAstNow,
  readCachedStreamingMarkdownAst,
  SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS,
  syncMarkdownParser,
} from './markdown-worker-client';
import MarkdownAstBody from './MarkdownAstBody';
import { containsFencedCodeMarkdown, MarkdownSourceFallback } from './MarkdownSourceFallback';
import { noteStreamSyncParse, noteStreamWorkerParse } from './transcript-stream-metrics';

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
  source: string,
  visibleSource: string
): RenderedMarkdownAst | null {
  if (current?.text === parsedText) return current;
  // Results are single-flight, but never let an older parse replace a newer
  // one if one ever lands out of order. A current parse the visible text has
  // since been cut or rewritten under is stale, not newer: the parse of the
  // shorter text on screen replaces it.
  if (
    current &&
    current.source.length > source.length &&
    current.source.startsWith(source) &&
    visibleSource.startsWith(current.source)
  ) {
    return current;
  }
  return { text: parsedText, source, root };
}

/** A main-thread parse slower than this hands longer text back to the worker.
 *  (Size cap: SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS in markdown-worker-client.) */
const SYNC_MARKDOWN_PARSE_BUDGET_MS = 8;

const ParsedMarkdownBody = memo(function ParsedMarkdownBody({
  text,
  parseText,
  parse,
  sync,
  copyControl,
}: {
  text: string;
  parseText: string;
  parse: boolean;
  sync: boolean;
  copyControl: MarkdownCopyControl;
}) {
  const slowAt = useRef(Number.POSITIVE_INFINITY);
  const lastSync = useRef<RenderedMarkdownAst | null>(null);
  const parser =
    sync && parse && parseText.length <= SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS && parseText.length < slowAt.current
      ? syncMarkdownParser()
      : null;
  const syncRoot = useMemo(() => {
    // Settled text (history, a reply that arrived whole) commits its final
    // structure in the render that mounts it whenever the parser is loaded.
    if (!sync) return parse ? parseSettledMarkdownAstNow(parseText, SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS) : null;
    if (!parser) return null;
    const cached = readCachedStreamingMarkdownAst(parseText);
    if (cached) return cached;
    const startedAt = performance.now();
    const root = parser(parseText);
    const duration = performance.now() - startedAt;
    noteStreamSyncParse(duration, parseText.length);
    if (duration > SYNC_MARKDOWN_PARSE_BUDGET_MS) slowAt.current = parseText.length;
    return root;
  }, [parser, parseText, sync, parse]);
  if (syncRoot) lastSync.current = { text: parseText, source: text, root: syncRoot };
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
      const promoted = promoteMarkdownAst(current, cachedRoot, parseText, text, text);
      if (promoted !== current) {
        current = promoted;
        setRendered(promoted);
      }
    }
  }
  const exact = current?.text === parseText ? current : null;
  // While a newer parse is in flight, the last COMPLETED parse stays on
  // screen — also when the text was cut or rewritten under it. The live tail
  // chunk is cut to its frozen block every time the next block starts, and
  // dropping the stale parse there blanked the block (and the tail below it)
  // for a whole worker round trip: the transcript collapsed and regrew at
  // every paragraph (user: 웹앱에서 트랜스크립트가 튄다). The stale parse is
  // one worker round trip old and is replaced by the parse of the text on
  // screen as soon as it lands.
  const synced = lastSync.current;
  const usable =
    (syncRoot ? synced : null) ??
    exact ??
    (synced && (!current || synced.source.length >= current.source.length) ? synced : current);
  const renderedRoot = usable?.root ?? null;
  // A cold web Worker can trail the first streamed tokens by a network round
  // trip. Fenced scripts still reserve their final card/mono geometry during
  // that gap; ordinary prose stays hidden so raw Markdown markers never flash.
  // A completed reply (`sync` false) never paints source: raw prose and
  // tables would reflow into their final structure when the parse lands, so
  // its row stays reserved (CSS holds the measured/estimated box) and empty
  // until the AST arrives.
  const showFencedSourceFallback = sync && !renderedRoot && containsFencedCodeMarkdown(text);

  useEffect(() => {
    // A cached AST was already promoted during render; a main-thread parse
    // already painted this text.
    if (!parse || syncRoot || readCachedStreamingMarkdownAst(parseText)) return;
    // The source snapshot that produced this request: the render right before
    // this effect published it, so later growth can be recognised as append.
    const source = requestedSource.current;
    const requestedAt = performance.now();
    queue.current?.request(parseText, (root, parsedText) => {
      noteStreamWorkerParse(requestedAt);
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
      const visibleSource = requestedSource.current;
      setRendered((latest) => promoteMarkdownAst(latest, root, parsedText, source, visibleSource));
    });
  }, [parse, parseText, syncRoot]);
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
    // The projection only reserves geometry. Entry still waits for the parse:
    // revealing the projection and then swapping in the AST re-wrapped prose
    // and recoloured code in front of the reader (user: 세션 불러올 때 문자가
    // 재배열되는 느낌).
    return (
      <>
        <MarkdownSourceFallback text={text} copyControl={copyControl} />
        {parse && <span hidden data-transcript-pending />}
      </>
    );
  }
  // A capped live tail has no pending parse to wait for.
  return parse ? <span hidden data-transcript-pending /> : null;
});

const StreamingMarkdownBody = memo(function StreamingMarkdownBody({
  text,
  parseText,
  parse = true,
  sync = false,
  copyControl,
}: {
  text: string;
  parseText?: string;
  parse?: boolean;
  /** Live reply: small text parses on the main thread (see SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS). */
  sync?: boolean;
  copyControl: MarkdownCopyControl;
}) {
  // Stable chunks promote exactly (immutable text -> exact AST, whose source
  // never changes). The live tail renders the latest COMPLETED parse and
  // trails the raw text by worker latency (paced streaming markdown).
  // `parseText` is the healed form of `text` for the live tail: the parser
  // sees closed markers while the source fallback still shows exactly what
  // the model has emitted.
  return (
    <ParsedMarkdownBody text={text} parseText={parseText ?? text} parse={parse} sync={sync} copyControl={copyControl} />
  );
});

export default StreamingMarkdownBody;
