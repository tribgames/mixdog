import type { MarkdownAstRoot } from './markdown-ast';
import { registerIdleReclaim } from './idle-reclaim';
import { RendererLruCache } from './renderer-lru-cache';
import { MarkdownWorkerHost } from './markdown-worker-host';
import {
  markdownAstCacheChars,
  MARKDOWN_AST_CACHE_MAX_CHARACTERS as AST_CACHE_MAX_CHARACTERS,
} from './markdown-ast-weight';

const AST_CACHE_MAX_ENTRIES = 512;
const AST_CACHE_TOTAL_CHARACTERS = 8 * AST_CACHE_MAX_CHARACTERS;
const AST_CACHE_MAX_ENTRY_CHARACTERS = 128 * 1024;
const astCache = new RendererLruCache<string, MarkdownAstRoot>({
  name: 'markdown-ast',
  maxEntries: AST_CACHE_MAX_ENTRIES,
  maxChars: AST_CACHE_TOTAL_CHARACTERS,
  measure: markdownAstCacheChars,
});
const workerHost = new MarkdownWorkerHost();
let rendererParserPromise: Promise<typeof import('./markdown-ast')> | null = null;
let rendererLoadWasSpeculative = false;
// Different panes/blocks often request the same text before its AST arrives.
// Share that work, including fallback parsing, and release it after settlement.
const inFlight = new Map<string, Promise<MarkdownAstRoot>>();

export function readCachedStreamingMarkdownAst(text: string): MarkdownAstRoot | null {
  return astCache.get(String(text ?? '')) ?? null;
}

function rememberStreamingMarkdownAst(text: string, root: MarkdownAstRoot): void {
  if (!text || text.length > AST_CACHE_MAX_ENTRY_CHARACTERS) return;
  astCache.set(text, root);
}

// Parsed markdown is pure derived state: an idle drop costs one reparse the
// next time that exact text scrolls back into view. The parser itself stays
// resident, so that reparse never waits for a worker bootstrap.
registerIdleReclaim(() => {
  astCache.clear();
});

let rendererParser: ((text: string) => MarkdownAstRoot) | null = null;
const rendererParserListeners = new Set<() => void>();
type ParserLoad = 'idle' | 'pending' | 'ready' | { error: unknown };
let parserLoad: ParserLoad = 'idle';

export function syncMarkdownParserLoad(): ParserLoad {
  return parserLoad;
}

function publishParserLoad(state: ParserLoad): void {
  parserLoad = state;
  for (const listener of rendererParserListeners) listener();
}

function loadRendererParser(speculative = false): Promise<typeof import('./markdown-ast')> {
  // A real fallback can retry a failed warmup. Repeated preloads and failed
  // foreground imports must not start an import loop.
  if (!speculative && rendererLoadWasSpeculative && typeof parserLoad === 'object') {
    rendererParserPromise = null;
  }
  if (!rendererParserPromise) {
    rendererLoadWasSpeculative = speculative;
    rendererParserPromise = import('./markdown-ast').then(
      (module) => {
        rendererParser = module.parseMarkdownToHast;
        publishParserLoad('ready');
        return module;
      },
      (error: unknown) => {
        publishParserLoad({ error });
        throw error;
      }
    );
    publishParserLoad('pending');
  }
  return rendererParserPromise;
}

/** Subscribe to the shared import, including rejection. */
export function subscribeSyncMarkdownParser(listener: () => void): () => void {
  rendererParserListeners.add(listener);
  return () => rendererParserListeners.delete(listener);
}

function parseMarkdownOnRenderer(text: string): Promise<MarkdownAstRoot> {
  return loadRendererParser().then(({ parseMarkdownToHast }) => parseMarkdownToHast(text));
}

/** Live markdown parses its small tail on the main thread once the parser is
 *  loaded; a worker round trip per frame would gate what the reader sees. */
export function preloadSyncMarkdownParser(): Promise<void> {
  return loadRendererParser(true).then(
    () => undefined,
    () => undefined
  );
}

export function syncMarkdownParser(): ((text: string) => MarkdownAstRoot) | null {
  return rendererParser;
}

/** Largest text, counted in UTF-16 code units (`String.length`, not bytes and
 *  not code points), that parses on the main thread in the commit that shows
 *  it. Longer text stays on the worker.
 *
 *  Chosen from `scripts/markdown-sync-parse-bench.mjs` (lists, a table and a
 *  highlighted code block per ~1.1k units, dense on purpose): parsing costs
 *  about 1.25 ms per 1024 units, so 4096 units take a median ~5 ms (p95 ~7 ms)
 *  while 8192 take ~10 ms (p95 15-20 ms), already most of a 16.7 ms frame. */
export const SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS = 4096;

/** A main-thread parse slower than this hands longer text back to the worker. */
export const SYNC_MARKDOWN_PARSE_BUDGET_MS = 8;

const SETTLED_PARSE_FRAME_UTF16_UNITS = SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS;
let settledParseSpent = 0;
let settledParseResetQueued = false;

/** The allowance renews only at a real frame boundary (the next animation
 *  frame), never on a wall-clock window: commits that land before a frame
 *  paints keep drawing on the same allowance. */
function renewSettledParseAllowanceNextFrame(): void {
  if (settledParseResetQueued) return;
  settledParseResetQueued = true;
  requestAnimationFrame(() => {
    settledParseResetQueued = false;
    settledParseSpent = 0;
  });
}

/** A settled block's AST: the cached tree, or a main-thread parse within this
 *  frame's allowance. Null means "ask the worker". */
export function parseSettledMarkdownAstNow(text: string, maxUtf16Units: number): MarkdownAstRoot | null {
  const value = String(text ?? '');
  const cached = readCachedStreamingMarkdownAst(value);
  if (cached) return cached;
  if (!rendererParser || !value || value.length > maxUtf16Units) return null;
  if (settledParseSpent + value.length > SETTLED_PARSE_FRAME_UTF16_UNITS) return null;
  settledParseSpent += value.length;
  renewSettledParseAllowanceNextFrame();
  const root = rendererParser(value);
  rememberStreamingMarkdownAst(value, root);
  return root;
}

/** `text` as one paragraph of plain text: what a reply whose parse failed shows. */
function plainMarkdownAst(text: string): MarkdownAstRoot {
  return {
    type: 'root',
    children: [{ type: 'element', tagName: 'p', properties: {}, children: [{ type: 'text', value: text }] }],
  } as unknown as MarkdownAstRoot;
}

let parsersFail = false;
/** Test seam: the worker and the page's parser both fail, as when neither script can be loaded. */
export function _failMarkdownParsersForTest(fail: boolean): void {
  parsersFail = fail;
}

/** `remember: false` is for a live tail: each snapshot is a transient prefix
 *  that would otherwise evict settled history ASTs from the cache. */
export function parseStreamingMarkdownAst(text: string, remember = true): Promise<MarkdownAstRoot> {
  const value = String(text ?? '');
  const cached = readCachedStreamingMarkdownAst(value);
  if (cached) return Promise.resolve(cached);
  const pending = inFlight.get(value);
  if (pending) {
    if (!remember) return pending;
    return pending.then((root) => {
      rememberStreamingMarkdownAst(value, root);
      return root;
    });
  }
  const parser = (parse: () => Promise<MarkdownAstRoot>) =>
    parsersFail ? Promise.reject<MarkdownAstRoot>(new Error('no parser')) : parse();
  const request = parser(() => workerHost.parse(value))
    .catch(() => parser(() => parseMarkdownOnRenderer(value)))
    .then((root) => {
      if (remember) rememberStreamingMarkdownAst(value, root);
      return root;
    })
    // Neither the worker nor the page's own parser could be had: the parse ends all the same, as the text itself.
    // It is not remembered, so a later mount asks again.
    .catch(() => plainMarkdownAst(value))
    .finally(() => {
      inFlight.delete(value);
    });
  inFlight.set(value, request);
  return request;
}

export function parseLiveMarkdownAst(text: string): Promise<MarkdownAstRoot> {
  return parseStreamingMarkdownAst(text, false);
}

/** Speculative worker parses in flight at once; the newest range replaces
 *  whatever has not been sent yet, so a fast fling never queues stale rows
 *  ahead of the ones the reader is about to see. */
const PREFETCH_CONCURRENCY = 2;
let prefetchQueue: string[] = [];
let prefetchRunning = 0;

function pumpMarkdownPrefetch(): void {
  while (prefetchRunning < PREFETCH_CONCURRENCY && prefetchQueue.length > 0 && workerHost.available) {
    const text = prefetchQueue.shift() as string;
    if (astCache.peek(text) || inFlight.has(text)) continue;
    prefetchRunning += 1;
    void parseStreamingMarkdownAst(text)
      .catch(() => undefined)
      .finally(() => {
        prefetchRunning -= 1;
        pumpMarkdownPrefetch();
      });
  }
}

/** Settled text about to scroll into view parses on the worker, so its row
 *  mounts from the cache instead of parsing on the main thread in the commit
 *  that shows it. Nearest text first. */
export function prefetchMarkdownAsts(texts: readonly string[]): void {
  prefetchQueue = texts.filter(
    (text) => text.length > 0 && text.length <= AST_CACHE_MAX_ENTRY_CHARACTERS && !astCache.peek(text)
  );
  pumpMarkdownPrefetch();
}

interface QueuedMarkdownAstRequest {
  text: string;
  resolve(root: MarkdownAstRoot, text: string): void;
  reject?(error: Error, text: string): void;
}

// Parsing is deliberately single-flight per live block. If token publications
// outrun the worker, retain only the newest waiting value instead of queueing
// a full GFM parse for every obsolete 80ms snapshot.
export class LatestMarkdownAstQueue {
  private running = false;
  private disposed = false;
  private latest: QueuedMarkdownAstRequest | null = null;

  constructor(private readonly parse: (text: string) => Promise<MarkdownAstRoot> = parseStreamingMarkdownAst) {}

  request(
    text: string,
    resolve: QueuedMarkdownAstRequest['resolve'],
    reject?: QueuedMarkdownAstRequest['reject']
  ): void {
    if (this.disposed) return;
    this.latest = { text: String(text ?? ''), resolve, reject };
    this.drain();
  }

  dispose(): void {
    this.disposed = true;
    this.latest = null;
  }

  private drain(): void {
    if (this.disposed || this.running || !this.latest) return;
    const request = this.latest;
    this.latest = null;
    this.running = true;
    void this.parse(request.text)
      .then(
        (root) => {
          if (!this.disposed) request.resolve(root, request.text);
        },
        (error) => {
          if (!this.disposed) {
            request.reject?.(error instanceof Error ? error : new Error(String(error)), request.text);
          }
        }
      )
      .finally(() => {
        this.running = false;
        this.drain();
      });
  }
}
