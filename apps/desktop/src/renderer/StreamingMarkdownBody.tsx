import { createContext, memo, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';

import type { MarkdownAstRoot } from './markdown-ast';
import type { MarkdownCopyControl } from './markdown-components';
import {
  canSyncParseMarkdown,
  LatestMarkdownAstQueue,
  parseLiveMarkdownAst,
  parseSettledMarkdownAstNow,
  readCachedStreamingMarkdownAst,
  SYNC_MARKDOWN_PARSE_BUDGET_MS,
  SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS,
  syncMarkdownParser,
} from './markdown-worker-client';
import MarkdownAstBody from './MarkdownAstBody';
import { containsFencedCodeMarkdown, MarkdownSourceFallback } from './MarkdownSourceFallback';
import { noteStreamSyncParse, noteStreamWorkerParse } from './transcript-stream-metrics';

/** Optional visible fallback provided by an enclosing host (e.g. tool output
 *  panels) while the first parsed AST is still loading or parsing off-thread. */
export const StreamingMarkdownFallbackContext = createContext<ReactNode>(null);

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

const ParsedMarkdownBody = memo(function ParsedMarkdownBody({
  text,
  parseText,
  parse,
  sync,
  live,
  copyControl,
  fallback,
}: {
  text: string;
  parseText: string;
  parse: boolean;
  sync: boolean;
  /** A growing tail: its parses never enter the shared cache. */
  live: boolean;
  copyControl: MarkdownCopyControl;
  fallback?: ReactNode;
}) {
  const slowAt = useRef(Number.POSITIVE_INFINITY);
  const lastSync = useRef<RenderedMarkdownAst | null>(null);
  const parser =
    sync &&
    parse &&
    parseText.length <= SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS &&
    parseText.length < slowAt.current &&
    canSyncParseMarkdown(parseText)
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

  const contextFallback = useContext(StreamingMarkdownFallbackContext);
  const resolvedFallback = fallback ?? contextFallback;
  if (usable) {
    return <MarkdownAstBody root={usable.root} copyControl={copyControl} />;
  }
  if (resolvedFallback != null) {
    return (
      <>
        {resolvedFallback}
        {parse && <span hidden data-transcript-pending />}
      </>
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
  if (sync && !parse && text.trim()) {
    return <p className="markdown-plain">{text}</p>;
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
  fallback,
}: {
  text: string;
  parseText?: string;
  parse?: boolean;
  /** Live text: small text parses on the main thread (see SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS). */
  sync?: boolean;
  copyControl: MarkdownCopyControl;
  /** Visible fallback kept mounted until the first parsed AST lands. */
  fallback?: ReactNode;
}) {
  return (
    <ParsedMarkdownBody
      text={text}
      parseText={parseText ?? text}
      parse={parse}
      sync={sync}
      live={sync && parseText !== undefined}
      copyControl={copyControl}
      fallback={fallback}
    />
  );
});

export default StreamingMarkdownBody;
