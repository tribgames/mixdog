import { isResizeObserverDeferral } from './visualize/page-problems';

export type RendererConsoleError = {
  message: string;
  source: string;
  line: number;
  totalMs: number;
};

interface ConsoleMessageSource {
  on(event: 'console-message', listener: (event: unknown) => void): unknown;
}

// Renderer console errors had no sink outside the screenshot window, so a
// caught-and-logged failure left no evidence at all. Keep a bounded,
// de-duplicated tail: enough to explain a boot, never a growth path.
// Chromium's ResizeObserver deferral notice is no error and recurs for as long
// as a layout settles over two frames, so it takes none of the tail.
export function installRendererConsoleErrorTail(
  webContents: ConsoleMessageSource,
  startupStartedAt: number,
  write: (error: RendererConsoleError) => void
): void {
  const consoleErrorSeenAt = new Map<string, number>();
  let consoleErrorsWritten = 0;
  webContents.on('console-message', (event) => {
    const details = event as {
      level?: string;
      message?: string;
      lineNumber?: number;
      sourceId?: string;
    };
    if (details.level !== 'error' || consoleErrorsWritten >= 100) return;
    const message = String(details.message || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
    if (!message || isResizeObserverDeferral(message)) return;
    const now = Date.now();
    if (now - (consoleErrorSeenAt.get(message) ?? 0) < 10_000) return;
    if (consoleErrorSeenAt.size > 200) consoleErrorSeenAt.clear();
    consoleErrorSeenAt.set(message, now);
    consoleErrorsWritten += 1;
    write({
      message,
      source:
        String(details.sourceId || '')
          .split(/[\\/]/)
          .at(-1)
          ?.slice(0, 120) || '',
      line: Number(details.lineNumber) || 0,
      totalMs: now - startupStartedAt,
    });
  });
}
