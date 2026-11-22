import { preloadSyncMarkdownParser } from './markdown-worker-client';

let markdownBodyReady = false;
let markdownBodyPromise: Promise<typeof import('./MarkdownBody')> | null = null;

export function isMarkdownBodyReady(): boolean {
  return markdownBodyReady;
}

export function preloadMarkdownBody(): Promise<typeof import('./MarkdownBody')> {
  markdownBodyPromise ||= (async () => {
    // Capture-only race hook: a cold probe can force IPC to beat the lazy
    // chunk and prove that App keeps the transcript neutral until rich
    // Markdown is ready. Production never defines this property.
    const probeWindow = window as typeof window & { __mixdogMarkdownPreloadDelayMs?: number };
    const delayMs = Math.max(0, Number(probeWindow.__mixdogMarkdownPreloadDelayMs || 0));
    probeWindow.__mixdogMarkdownPreloadDelayMs = 0;
    if (delayMs > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, delayMs));
    }
    // A reply read from history shows the parse of its text: with the parser
    // loaded too, its first commit paints it.
    const [module] = await Promise.all([import('./MarkdownBody'), preloadSyncMarkdownParser()]);
    markdownBodyReady = true;
    return module;
  })().catch((error) => {
    markdownBodyPromise = null;
    throw error;
  });
  return markdownBodyPromise;
}
