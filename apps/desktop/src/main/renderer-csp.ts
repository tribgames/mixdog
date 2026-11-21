import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The packaged policy grants the boot.js that electron.vite.config.ts inlines
 *  into index.html by hash, only when the document contains it. */
export function inlineBootScriptHash(rendererDir: string): string | null {
  try {
    const source = readFileSync(join(rendererDir, 'boot.js'), 'utf8');
    const document = readFileSync(join(rendererDir, 'index.html'), 'utf8');
    if (!document.includes(`<script>${source}</script>`)) return null;
    return createHash('sha256').update(source).digest('base64');
  } catch {
    return null;
  }
}

export function withInlineBootScript(policy: string, hash: string | null): string {
  return hash ? policy.replace("script-src 'self'", `script-src 'self' 'sha256-${hash}'`) : policy;
}
