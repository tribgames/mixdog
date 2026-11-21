import { memo, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';

import type { MarkdownAstRoot } from './markdown-ast';
import {
  LatestMarkdownAstQueue,
  parseLiveMarkdownAst,
  parseSettledMarkdownAstNow,
  readCachedStreamingMarkdownAst,
  SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS,
  syncMarkdownParser,
} from './markdown-worker-client';
import MarkdownAstBody from './MarkdownAstBody';
import type { StreamFadeTimeline } from './markdown-stream-fade';
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
  final,
  live,
  fadeTimeline,
  fadeOffset,
  copyControl,
}: {
  text: string;
  parseText: string;
  parse: boolean;
  sync: boolean;
  /** The text a streamed reply ended with: it parses on the main thread in
   *  the commit that ends the reply, whatever its length, so the rest of the
   *  reply shows at once (never after a worker round trip). */
  final: boolean;
  /** A streamed reply's growing tail: its parses never enter the shared cache. */
  live: boolean;
  fadeTimeline: StreamFadeTimeline | null;
  fadeOffset: number;
  copyControl: MarkdownCopyControl;
}) {
  const slowAt = useRef(Number.POSITIVE_INFINITY);
  const lastSync = useRef<RenderedMarkdownAst | null>(null);
  const parser =
    sync &&
    parse &&
    (final || (parseText.length <= SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS && parseText.length < slowAt.current))
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
  // A live tail's worker results stay local to this body (see parseLiveMarkdownAst).
  queue.current ??= new LatestMarkdownAstQueue(live ? parseLiveMarkdownAst : undefined);
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
  const synced = lastSync.current;
  const usable =
    (syncRoot ? synced : null) ??
    exact ??
    (synced && (!current || synced.source.length >= current.source.length) ? synced : current);
  const renderedRoot = usable?.root ?? null;
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
      if (requestedText.current !== parsedText && !requestedSource.current.startsWith(source)) {
        return;
      }
      // One landed parse, one commit.
      const visibleSource = requestedSource.current;
      setRendered((latest) => promoteMarkdownAst(latest, root, parsedText, source, visibleSource));
    });
  }, [parse, parseText, syncRoot]);
  useEffect(() => () => queue.current?.dispose(), []);

  if (usable) {
    return (
      <MarkdownAstBody
        root={usable.root}
        copyControl={copyControl}
        fadeTimeline={fadeTimeline}
        fadeOffset={fadeOffset}
        // An older parse covers only the text it was parsed from: the rest
        // comes on screen (and starts fading) when its parse lands.
        fadeEnd={fadeOffset + usable.source.length}
      />
    );
  }
  if (showFencedSourceFallback) {
    // The projection only reserves geometry. Entry still waits for the parse:
    // revealing the projection and then swapping in the AST re-wrapped prose
    // and recoloured code in front of the reader.
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
  final = false,
  fadeTimeline = null,
  fadeOffset = 0,
  copyControl,
}: {
  text: string;
  parseText?: string;
  parse?: boolean;
  /** Live reply: small text parses on the main thread (see SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS). */
  sync?: boolean;
  /** A streamed reply's ending text: it parses in the commit that shows it. */
  final?: boolean;
  /** A streamed reply's timeline: its text fades in (markdown-stream-fade). */
  fadeTimeline?: StreamFadeTimeline | null;
  /** Where this chunk starts in the reply. */
  fadeOffset?: number;
  copyControl: MarkdownCopyControl;
}) {
  return (
    <ParsedMarkdownBody
      text={text}
      parseText={parseText ?? text}
      parse={parse}
      sync={sync}
      final={final}
      live={sync && parseText !== undefined}
      fadeTimeline={fadeTimeline}
      fadeOffset={fadeOffset}
      copyControl={copyControl}
    />
  );
});

export default StreamingMarkdownBody;
