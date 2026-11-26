import type { MarkdownAstRoot } from './markdown-ast';
import { registerIdleReclaim } from './idle-reclaim';
import { containsMarkdownMath } from './markdown-math-detect';
import { MarkdownWorkerHost } from './markdown-worker-host';
import { RendererLruCache } from './renderer-lru-cache';
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
let rendererParserModule: typeof import('./markdown-ast') | null = null;
let rendererLoadWasSpeculative = false;
// Different panes/blocks often request the same text before its AST arrives.
// Share that work and release it after settlement.
const inFlight = new Map<string, Promise<MarkdownAstRoot>>();

export function readCachedStreamingMarkdownAst(text: string): MarkdownAstRoot | null {
  return astCache.get(String(text ?? '')) ?? null;
}

function rememberStreamingMarkdownAst(text: string, root: MarkdownAstRoot): void {
  if (!text || text.length > AST_CACHE_MAX_ENTRY_CHARACTERS) return;
  astCache.set(text, root);
}

export const HIDDEN_WORKER_RECLAIM_MS = 5 * 60_000;
let hiddenReclaimTimer: ReturnType<typeof setTimeout> | null = null;
const observedDocuments = new WeakSet<Document>();

function clearHiddenWorkerReclaim(): void {
  if (hiddenReclaimTimer !== null) {
    clearTimeout(hiddenReclaimTimer);
    hiddenReclaimTimer = null;
  }
}

function scheduleHiddenWorkerReclaim(): void {
  clearHiddenWorkerReclaim();
  if (
    inFlight.size > 0 ||
    !workerHost.active ||
    typeof document === 'undefined' ||
    document.visibilityState !== 'hidden'
  ) {
    return;
  }
  hiddenReclaimTimer = setTimeout(() => {
    hiddenReclaimTimer = null;
    if (inFlight.size === 0 && typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      workerHost.terminateIdle();
    }
  }, HIDDEN_WORKER_RECLAIM_MS);
  if (typeof hiddenReclaimTimer === 'object' && hiddenReclaimTimer !== null && 'unref' in hiddenReclaimTimer) {
    (hiddenReclaimTimer as { unref(): void }).unref();
  }
}

function ensureVisibilityListener(): void {
  if (typeof document === 'undefined' || observedDocuments.has(document)) return;
  observedDocuments.add(document);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') scheduleHiddenWorkerReclaim();
    else clearHiddenWorkerReclaim();
  });
}
ensureVisibilityListener();

// Parsed markdown is pure derived state: an explicit idle/memory-pressure
// reclaim drops cached ASTs and terminates the idle worker.
registerIdleReclaim(() => {
  clearHiddenWorkerReclaim();
  prefetchQueue = [];
  astCache.clear();
  workerHost.terminateIdle();
});

export function isMarkdownWorkerActive(): boolean {
  return workerHost.active;
}

export function terminateIdleMarkdownWorker(): boolean {
  const terminated = workerHost.terminateIdle();
  if (terminated) clearHiddenWorkerReclaim();
  return terminated;
}

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
  // A real foreground request can retry a failed warmup. Repeated preloads and
  // failed foreground imports must not start an import loop.
  if (!speculative && rendererLoadWasSpeculative && typeof parserLoad === 'object') {
    rendererParserPromise = null;
  }
  if (!rendererParserPromise) {
    rendererLoadWasSpeculative = speculative;
    rendererParserPromise = import('./markdown-ast').then(
      (module) => {
        rendererParserModule = module;
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
  return loadRendererParser().then((module) => module.parseMarkdownToHastAsync(text));
}

/** Loads the single resident Markdown parser on the main thread so settled
 *  first-paint blocks and live streaming tails parse without an async hop. */
export function preloadSyncMarkdownParser(): Promise<void> {
  return loadRendererParser(true).then(
    () => undefined,
    () => undefined
  );
}

export function syncMarkdownParser(): ((text: string) => MarkdownAstRoot) | null {
  return rendererParser;
}

export { containsMarkdownMath };

/** True when `text` can parse synchronously without skipping unloaded math plugins. */
export function canSyncParseMarkdown(text: string): boolean {
  if (!rendererParser) return false;
  if (!containsMarkdownMath(text)) return true;
  return rendererParserModule?.isMarkdownMathLoaded() === true;
}

/** Loads KaTeX/remark-math on demand when a live stream begins emitting math. */
export function preloadMarkdownMath(): Promise<void> {
  return loadRendererParser(true)
    .then((module) => module.loadMarkdownMathSupport())
    .catch(() => undefined);
}

/** Largest text, counted in UTF-16 code units (`String.length`, not bytes and
 *  not code points), that parses on the main thread in the commit that shows
 *  it. Longer text parses asynchronously after the commit paints.
 *
 *  Chosen from `scripts/markdown-sync-parse-bench.mjs` (lists, a table and a
 *  highlighted code block per ~1.1k units, dense on purpose): parsing costs
 *  about 1.25 ms per 1024 units, so 4096 units take a median ~5 ms (p95 ~7 ms)
 *  while 8192 take ~10 ms (p95 15-20 ms), already most of a 16.7 ms frame. */
export const SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS = 4096;

/** A main-thread parse slower than this hands longer text to the async queue. */
export const SYNC_MARKDOWN_PARSE_BUDGET_MS = 8;

/** Frame allowance for synchronous settled-reply parsing on session open: lets
 *  multiple visible tail replies parse in the first commit while keeping each
 *  individual reply capped at SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS. */
export const SETTLED_PARSE_FRAME_UTF16_UNITS = 3 * SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS;
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
 *  frame's allowance. Null means "parse asynchronously". */
export function parseSettledMarkdownAstNow(text: string, maxUtf16Units: number): MarkdownAstRoot | null {
  const value = String(text ?? '');
  const cached = readCachedStreamingMarkdownAst(value);
  if (cached) return cached;
  if (!rendererParser || !value || value.length > maxUtf16Units) return null;
  if (!canSyncParseMarkdown(value)) return null;
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
/** Test seam: the parser fails, as when the script chunk cannot be loaded. */
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
  const parse = (): Promise<MarkdownAstRoot> => {
    if (parsersFail) return Promise.reject<MarkdownAstRoot>(new Error('no parser'));
    if (workerHost.available) {
      ensureVisibilityListener();
      clearHiddenWorkerReclaim();
      return workerHost.parse(value).catch(() => parseMarkdownOnRenderer(value));
    }
    return parseMarkdownOnRenderer(value);
  };
  const request = parse()
    .then((root) => {
      if (remember) rememberStreamingMarkdownAst(value, root);
      return root;
    })
    // The parser could not be loaded: the parse ends all the same, as the text itself.
    // It is not remembered, so a later mount asks again.
    .catch(() => plainMarkdownAst(value))
    .finally(() => {
      inFlight.delete(value);
      if (inFlight.size === 0) scheduleHiddenWorkerReclaim();
    });
  inFlight.set(value, request);
  return request;
}

export function parseLiveMarkdownAst(text: string): Promise<MarkdownAstRoot> {
  return parseStreamingMarkdownAst(text, false);
}

const PREFETCH_CONCURRENCY = 1;
let prefetchQueue: string[] = [];
let prefetchScheduled = false;
let prefetchRunning = 0;

function schedulePrefetchTurn(run: (deadline?: IdleDeadline) => void): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback((deadline) => run(deadline), { timeout: 100 });
  } else {
    setTimeout(() => run(), 0);
  }
}

function pumpMarkdownPrefetch(): void {
  if (prefetchScheduled || prefetchRunning >= PREFETCH_CONCURRENCY || prefetchQueue.length === 0) return;
  if (!workerHost.available && typeof parserLoad === 'object') return;
  prefetchScheduled = true;
  schedulePrefetchTurn((deadline) => {
    prefetchScheduled = false;
    if (deadline && deadline.timeRemaining() <= 0 && !deadline.didTimeout) {
      pumpMarkdownPrefetch();
      return;
    }
    while (prefetchRunning < PREFETCH_CONCURRENCY && prefetchQueue.length > 0) {
      const text = prefetchQueue.shift() as string;
      if (astCache.peek(text) || inFlight.has(text)) continue;
      prefetchRunning += 1;
      void parseStreamingMarkdownAst(text)
        .catch(() => undefined)
        .finally(() => {
          prefetchRunning = Math.max(0, prefetchRunning - 1);
          pumpMarkdownPrefetch();
        });
      return;
    }
  });
}

/** Settled text about to scroll into view parses across idle turns so its row
 *  mounts from the cache instead of parsing in the commit that shows it. */
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
