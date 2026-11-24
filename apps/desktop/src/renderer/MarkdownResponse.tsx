import { memo, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';

import type { MarkdownAstRoot } from './markdown-ast';
import { createBlockParking, MarkdownBlockParkingContext } from './markdown-block-parking';
import { finishDocument, LiveMarkdownDocument, type MarkdownPage } from './markdown-document';
import type { StreamFadeTimeline } from './markdown-stream-fade';
import {
  parseSettledMarkdownAstNow,
  parseStreamingMarkdownAst,
  preloadSyncMarkdownParser,
  readCachedStreamingMarkdownAst,
  SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS,
  syncMarkdownParser,
} from './markdown-worker-client';
import { MarkdownDocumentView } from './MarkdownDocumentView';
import { CopyControl } from './transcript-primitives';
import { noteStreamCommit } from './transcript-stream-metrics';

const EMPTY_AST: MarkdownAstRoot = { type: 'root', children: [] };

/** The parse of a finished reply's whole `text`, if it can be had now. One
 *  that `ended` here parses whatever its length, so the rest of it shows in
 *  the commit that ends it; one read from history parses within the frame's
 *  allowance. */
function wholeParse(text: string, ended: boolean): MarkdownAstRoot | null {
  if (!text) return EMPTY_AST;
  if (!ended) return parseSettledMarkdownAstNow(text, SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS);
  return readCachedStreamingMarkdownAst(text) ?? syncMarkdownParser()?.(text) ?? null;
}

/** A reply is Live while it streams and Finished after: Finished shows the
 *  parse of its whole text, as a reply read from history does. */
interface ReplyDocument {
  live: LiveMarkdownDocument | null;
  finished: MarkdownPage | null;
  /** The text `finished` shows. */
  text: string;
}

export const MarkdownResponse = memo(function MarkdownResponse({
  text,
  streaming,
  fadeTimeline = null,
}: {
  text: string;
  streaming: boolean;
  /** The reply's fade timeline (useStreamFade); null: nothing fades. */
  fadeTimeline?: StreamFadeTimeline | null;
}) {
  const [, landed] = useReducer((count: number) => count + 1, 0);
  const reply = useRef<ReplyDocument>({ live: null, finished: null, text: '' });
  const workerPipeline = useRef(streaming);
  const markdownRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (streaming) noteStreamCommit(text.length);
  }, [streaming, text]);
  // A reply keeps only the blocks near the reader in the DOM; one still
  // arriving or fading in also keeps its held blocks.
  const [parking] = useState(createBlockParking);
  const growing = streaming || Boolean(fadeTimeline);
  useLayoutEffect(() => {
    parking.attach(markdownRef.current, true, growing);
  }, [parking, growing]);
  useEffect(() => () => parking.attach(null, false), [parking]);
  // A reply that unmounts asks for no more of its live parses.
  useEffect(() => {
    const state = reply.current;
    return () => {
      state.live?.retire();
      state.live = null;
    };
  }, []);
  if (streaming) workerPipeline.current = true;
  // Every reply loads the main-thread parser: a reply that arrives whole, or
  // the next settled row, then paints parsed in its first commit.
  useEffect(() => {
    void preloadSyncMarkdownParser();
  }, []);

  const state = reply.current;
  let pages: MarkdownPage | null = null;
  let awaitingWhole = false;
  // The parse of `text` this reply awaited: the cache may not keep it (a failed parse, a reply past the cache's entry
  // bound, an eviction before this commit).
  const ended = useRef<{ text: string; root: MarkdownAstRoot } | null>(null);
  if (streaming) {
    state.finished = null;
    state.live ??= new LiveMarkdownDocument(landed);
    pages = state.live.update(text);
  } else if (state.finished && state.text === text) {
    pages = state.finished;
  } else {
    const root = wholeParse(text, Boolean(state.live)) ?? (ended.current?.text === text ? ended.current.root : null);
    if (root) {
      // Built from what shows, so what the parse keeps keeps its elements;
      // then nothing of the live reply is kept.
      pages = finishDocument(state.live?.current() ?? state.finished, root, text.length);
      state.live?.retire();
      state.live = null;
      state.finished = pages;
      state.text = text;
    } else {
      // What showed stays until the parse lands.
      pages = state.live?.current() ?? state.finished;
      awaitingWhole = true;
    }
  }
  useEffect(() => {
    reply.current.live?.flush();
  });
  useEffect(() => {
    if (!awaitingWhole) return;
    let current = true;
    // Every parse ends, settled or failed: either way the reply stops waiting and shows what the parse gave.
    void parseStreamingMarkdownAst(text).then((root) => {
      if (!current) return;
      ended.current = { text, root };
      landed();
    });
    return () => {
      current = false;
    };
  }, [awaitingWhole, text]);

  // `streamed`: this mount watched the reply arrive (22-markdown.css keeps its
  // line breaks greedy, also once it settles).
  return (
    <MarkdownBlockParkingContext.Provider value={parking}>
      <div
        ref={markdownRef}
        className={`markdown ${streaming ? 'streaming' : ''}${workerPipeline.current ? ' streamed' : ''}`}
      >
        {pages ? (
          <MarkdownDocumentView root={pages} fadeTimeline={fadeTimeline} copyControl={CopyControl} />
        ) : (
          <span hidden data-transcript-pending />
        )}
      </div>
    </MarkdownBlockParkingContext.Provider>
  );
});
