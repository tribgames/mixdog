import type { MarkdownAstRoot } from "./markdown-ast";

interface MarkdownWorkerResponse {
  id: number;
  root?: MarkdownAstRoot;
  error?: string;
}

interface PendingMarkdownRequest {
  text: string;
  resolve(root: MarkdownAstRoot): void;
  reject(error: Error): void;
}

const AST_CACHE_MAX_ENTRIES = 64;
const AST_CACHE_MAX_CHARACTERS = 1024 * 1024;
const AST_CACHE_MAX_ENTRY_CHARACTERS = 128 * 1024;
const astCache = new Map<string, MarkdownAstRoot>();
let astCacheCharacters = 0;
let markdownWorker: Worker | null = null;
let requestSequence = 0;
const pendingRequests = new Map<number, PendingMarkdownRequest>();

export function readCachedStreamingMarkdownAst(text: string): MarkdownAstRoot | null {
  const value = String(text ?? "");
  const cached = astCache.get(value);
  if (!cached) return null;
  astCache.delete(value);
  astCache.set(value, cached);
  return cached;
}

function rememberStreamingMarkdownAst(text: string, root: MarkdownAstRoot): void {
  if (!text || text.length > AST_CACHE_MAX_ENTRY_CHARACTERS) return;
  const previous = astCache.get(text);
  if (previous) {
    astCache.delete(text);
    astCacheCharacters -= text.length;
  }
  astCache.set(text, root);
  astCacheCharacters += text.length;
  while (
    astCache.size > AST_CACHE_MAX_ENTRIES
    || astCacheCharacters > AST_CACHE_MAX_CHARACTERS
  ) {
    const oldest = astCache.keys().next().value;
    if (typeof oldest !== "string") break;
    astCache.delete(oldest);
    astCacheCharacters -= oldest.length;
  }
}

function rejectPendingRequests(error: Error): void {
  for (const request of pendingRequests.values()) request.reject(error);
  pendingRequests.clear();
}

function resetWorker(error: Error): void {
  rejectPendingRequests(error);
  markdownWorker?.terminate();
  markdownWorker = null;
}

function getMarkdownWorker(): Worker {
  if (markdownWorker) return markdownWorker;
  if (typeof Worker === "undefined") {
    throw new Error("Markdown Worker is unavailable");
  }
  const worker = new Worker(new URL("./markdown-parser.worker.ts", import.meta.url), {
    type: "module",
    name: "mixdog-markdown-parser",
  });
  worker.addEventListener("message", (event: MessageEvent<MarkdownWorkerResponse>) => {
    const request = pendingRequests.get(Number(event.data?.id));
    if (!request) return;
    pendingRequests.delete(Number(event.data.id));
    if (event.data.error || !event.data.root) {
      request.reject(new Error(event.data.error || "Markdown Worker returned no AST"));
      return;
    }
    rememberStreamingMarkdownAst(request.text, event.data.root);
    request.resolve(event.data.root);
  });
  worker.addEventListener("error", (event) => {
    resetWorker(new Error(event.message || "Markdown Worker failed"));
  });
  worker.addEventListener("messageerror", () => {
    resetWorker(new Error("Markdown Worker returned an unreadable response"));
  });
  markdownWorker = worker;
  return worker;
}

export function parseStreamingMarkdownAst(text: string): Promise<MarkdownAstRoot> {
  const value = String(text ?? "");
  const cached = readCachedStreamingMarkdownAst(value);
  if (cached) return Promise.resolve(cached);
  let worker: Worker;
  try {
    worker = getMarkdownWorker();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  const id = ++requestSequence;
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { text: value, resolve, reject });
    try {
      worker.postMessage({ id, text: value });
    } catch (error) {
      pendingRequests.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
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
