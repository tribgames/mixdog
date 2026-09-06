import type { MarkdownAstRoot } from "./markdown-ast";
import { registerIdleReclaim } from "./idle-reclaim";
import { RendererLruCache } from "./renderer-lru-cache";
import { MarkdownWorkerHost } from "./markdown-worker-host";
import {
  markdownAstCacheChars,
  MARKDOWN_AST_CACHE_MAX_CHARACTERS as AST_CACHE_MAX_CHARACTERS,
} from "./markdown-ast-weight";

const AST_CACHE_MAX_ENTRIES = 64;
const AST_CACHE_MAX_ENTRY_CHARACTERS = 128 * 1024;
const astCache = new RendererLruCache<string, MarkdownAstRoot>({
  name: "markdown-ast",
  maxEntries: AST_CACHE_MAX_ENTRIES,
  maxChars: AST_CACHE_MAX_CHARACTERS,
  measure: markdownAstCacheChars,
});
const workerHost = new MarkdownWorkerHost();
let rendererParserPromise: Promise<typeof import("./markdown-ast")> | null = null;
// Different panes/blocks often request the same text before its AST arrives.
// Share that work, including fallback parsing, and release it after settlement.
const inFlight = new Map<string, Promise<MarkdownAstRoot>>();

export function readCachedStreamingMarkdownAst(text: string): MarkdownAstRoot | null {
  const value = String(text ?? "");
  const cached = astCache.get(value);
  if (!cached) return null;
  return cached;
}

function rememberStreamingMarkdownAst(text: string, root: MarkdownAstRoot): void {
  if (!text || text.length > AST_CACHE_MAX_ENTRY_CHARACTERS) return;
  astCache.set(text, root);
}

// Parsed markdown is pure derived state: an idle drop costs one reparse the
// next time that exact text scrolls back into view.
registerIdleReclaim(() => {
  astCache.clear();
  workerHost.reclaim();
});

function parseMarkdownOnRenderer(text: string): Promise<MarkdownAstRoot> {
  rendererParserPromise ||= import("./markdown-ast");
  return rendererParserPromise.then(({ parseMarkdownToHast }) => parseMarkdownToHast(text));
}

export function parseStreamingMarkdownAst(text: string): Promise<MarkdownAstRoot> {
  const value = String(text ?? "");
  const cached = readCachedStreamingMarkdownAst(value);
  if (cached) return Promise.resolve(cached);
  const pending = inFlight.get(value);
  if (pending) return pending;
  const request = workerHost.parse(value)
    .catch(() => parseMarkdownOnRenderer(value))
    .then((root) => {
      rememberStreamingMarkdownAst(value, root);
      return root;
    })
    .finally(() => { inFlight.delete(value); });
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

  constructor(
    private readonly parse: (text: string) => Promise<MarkdownAstRoot> =
      parseStreamingMarkdownAst,
  ) {}

  request(
    text: string,
    resolve: QueuedMarkdownAstRequest["resolve"],
    reject?: QueuedMarkdownAstRequest["reject"],
  ): void {
    if (this.disposed) return;
    this.latest = { text: String(text ?? ""), resolve, reject };
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
    void this.parse(request.text).then(
      (root) => {
        if (!this.disposed) request.resolve(root, request.text);
      },
      (error) => {
        if (!this.disposed) {
          request.reject?.(
            error instanceof Error ? error : new Error(String(error)),
            request.text,
          );
        }
      },
    ).finally(() => {
      this.running = false;
      this.drain();
    });
  }
}
