import type { MarkdownAstRoot } from './markdown-ast';
import { registerIdleReclaim } from './idle-reclaim';
import { RendererLruCache } from './renderer-lru-cache';
import { MarkdownWorkerHost } from './markdown-worker-host';
import {
  markdownAstCacheChars,
  MARKDOWN_AST_CACHE_MAX_CHARACTERS as AST_CACHE_MAX_CHARACTERS,
} from './markdown-ast-weight';

const AST_CACHE_MAX_ENTRIES = 64;
const AST_CACHE_MAX_ENTRY_CHARACTERS = 128 * 1024;
const astCache = new RendererLruCache<string, MarkdownAstRoot>({
  name: 'markdown-ast',
  maxEntries: AST_CACHE_MAX_ENTRIES,
  maxChars: AST_CACHE_MAX_CHARACTERS,
  measure: markdownAstCacheChars,
});
const workerHost = new MarkdownWorkerHost();
let rendererParserPromise: Promise<typeof import('./markdown-ast')> | null = null;
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
workerHost.prewarm();

let rendererParser: ((text: string) => MarkdownAstRoot) | null = null;

function loadRendererParser(): Promise<typeof import('./markdown-ast')> {
  rendererParserPromise ||= import('./markdown-ast').then((module) => {
    rendererParser = module.parseMarkdownToHast;
    return module;
  });
  return rendererParserPromise;
}

function parseMarkdownOnRenderer(text: string): Promise<MarkdownAstRoot> {
  return loadRendererParser().then(({ parseMarkdownToHast }) => parseMarkdownToHast(text));
}

/** Live markdown parses its small tail on the main thread once the parser is
 *  loaded; a worker round trip per frame would gate what the reader sees. */
export function preloadSyncMarkdownParser(): Promise<void> {
  return loadRendererParser().then(
    () => undefined,
    () => {
      rendererParserPromise = null;
    }
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

/** Settled blocks share ONE frame's worth of main-thread parsing: this many
 *  UTF-16 code units, i.e. one maximum-size reply. Several replies mounting in
 *  one commit would otherwise each parse synchronously and stall the frame for
 *  the sum; the ones past the allowance go to the worker. */
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

/** A settled block's AST in the render that mounts it: the cached tree, or a
 *  main-thread parse once the parser is loaded and this frame's allowance
 *  covers it. Waiting for the worker painted the block as raw source (or
 *  nothing) first, then swapped in tables, links and code cards at another
 *  height, moving the transcript. The result is cached so a remount or another
 *  pane reuses it. A null return means "ask the worker". */
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

export function parseStreamingMarkdownAst(text: string): Promise<MarkdownAstRoot> {
  const value = String(text ?? '');
  const cached = readCachedStreamingMarkdownAst(value);
  if (cached) return Promise.resolve(cached);
  const pending = inFlight.get(value);
  if (pending) return pending;
  const request = workerHost
    .parse(value)
    .catch(() => parseMarkdownOnRenderer(value))
    .then((root) => {
      rememberStreamingMarkdownAst(value, root);
      return root;
    })
    .finally(() => {
      inFlight.delete(value);
    });
  inFlight.set(value, request);
  return request;
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
