import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface DesktopDiagnosticContext {
  appVersion: string;
  packaged: boolean;
  platform?: string;
  arch?: string;
  pid?: number;
}

export interface DesktopDiagnostics {
  readonly filePath: string;
  write(event: string, details?: Readonly<Record<string, unknown>>): void;
  flush(): Promise<void>;
}

interface DesktopDiagnosticsOptions {
  maxBytes?: number;
  now?: () => Date;
}

const DEFAULT_MAX_BYTES = 512 * 1024;

export function createDesktopDiagnostics(
  filePath: string,
  context: DesktopDiagnosticContext,
  options: DesktopDiagnosticsOptions = {},
): DesktopDiagnostics {
  const maxBytes = Math.max(4 * 1024, Number(options.maxBytes) || DEFAULT_MAX_BYTES);
  const now = options.now ?? (() => new Date());
  let queue = Promise.resolve();

  const write = (event: string, details: Readonly<Record<string, unknown>> = {}): void => {
    const line = `${JSON.stringify({
      schemaVersion: 1,
      at: now().toISOString(),
      event,
      pid: context.pid ?? process.pid,
      platform: context.platform ?? process.platform,
      arch: context.arch ?? process.arch,
      appVersion: context.appVersion,
      packaged: context.packaged,
      ...details,
    })}\n`;
    const bytes = Buffer.byteLength(line);
    queue = queue.then(async () => {
      await mkdir(dirname(filePath), { recursive: true });
      let existingBytes = 0;
      try {
        existingBytes = (await stat(filePath)).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (existingBytes > 0 && existingBytes + bytes > maxBytes) {
        await rm(`${filePath}.1`, { force: true });
        await rename(filePath, `${filePath}.1`);
      }
      await appendFile(filePath, line, { encoding: 'utf8', mode: 0o600 });
    }).catch((error: unknown) => {
      // Diagnostics must never become a new desktop failure path.
      console.warn('Failed to write Mixdog desktop diagnostics:', error);
    });
  };

  return {
    filePath,
    write,
    flush: () => queue,
  };
}
