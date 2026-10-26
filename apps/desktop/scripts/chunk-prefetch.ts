import { resolve } from 'node:path';
import type { Plugin } from 'vite';

/** The renderer imports the file lists from this module (src/renderer/chunk-prefetch.ts). */
export const CHUNK_PREFETCH_MODULE = 'virtual:mixdog-chunk-prefetch';
const RESOLVED = `\0${CHUNK_PREFETCH_MODULE}`;
const PLACEHOLDER = '__MIXDOG_CHUNK_PREFETCH__';
/** Reserved length of the lists' string literal. The lists are only known in
 *  generateBundle, after the chunk's sourcemap was made: written into a slot
 *  of the same length (padded with JSON whitespace), no generated position
 *  moves and the map stays exact. Gzip folds the padding away. Not a platform
 *  limit: only padding in one chunk, sized for headroom (the six lists were
 *  ~7.5k chars at 49c2f4fee and 8.3k two commits later, as shared chunks split). */
export const CHUNK_PREFETCH_SLOT = 16384;
const SLOT = PLACEHOLDER + '_'.repeat(CHUNK_PREFETCH_SLOT - PLACEHOLDER.length);
// The literal survives minification as a plain string. The dev server has no
// bundle: the lists stay empty there.
export const CHUNK_PREFETCH_SOURCE = `const raw = "${SLOT}";\nexport const chunkFiles = raw.charAt(0) === "{" ? JSON.parse(raw) : {};\n`;

type BundleChunk = {
  type: string;
  fileName: string;
  facadeModuleId?: string | null;
  moduleIds?: readonly string[];
  imports?: readonly string[];
  code?: string;
  viteMetadata?: { importedCss?: Set<string> };
};

const normalize = (path: string) => resolve(path).replace(/\\/g, '/').toLowerCase();

/** Every file a module's first import needs: the chunk holding it, its static
 *  imports (transitively) and their stylesheets. Dynamic imports are left out:
 *  they load on their own later. */
export function chunkFilesFor(bundle: Record<string, BundleChunk>, modulePath: string): string[] {
  const target = normalize(modulePath);
  const chunks = Object.values(bundle).filter((output) => output.type === 'chunk');
  const home =
    chunks.find((chunk) => chunk.facadeModuleId && normalize(chunk.facadeModuleId) === target) ??
    chunks.find((chunk) => chunk.moduleIds?.some((id) => normalize(id) === target));
  if (!home) return [];
  const files: string[] = [];
  const styles: string[] = [];
  const visit = (fileName: string): void => {
    if (files.includes(fileName)) return;
    const chunk = bundle[fileName];
    if (chunk?.type !== 'chunk') return;
    files.push(fileName);
    for (const css of chunk.viteMetadata?.importedCss ?? []) if (!styles.includes(css)) styles.push(css);
    for (const dependency of chunk.imports ?? []) visit(dependency);
  };
  visit(home.fileName);
  return [...files, ...styles];
}

/** Exposes, per name, the built files of a lazily imported module, so a page
 *  can download them ahead of time (`<link rel="modulepreload">`) without
 *  evaluating them. */
export function chunkPrefetchPlugin(targets: Record<string, string>): Plugin {
  return {
    name: 'mixdog-chunk-prefetch',
    resolveId: (id) => (id === CHUNK_PREFETCH_MODULE ? RESOLVED : null),
    load: (id) => (id === RESOLVED ? CHUNK_PREFETCH_SOURCE : null),
    // After Vite's own generateBundle hooks: vite:css-post deletes the JS
    // chunks of CSS-only modules (font-faces, bootstrap-styles) there, and a
    // list naming one sent the phone a 404, which the boot script answers with
    // a reload.
    enforce: 'post',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const outputs = bundle as unknown as Record<string, BundleChunk>;
        const lists = Object.fromEntries(
          Object.entries(targets).map(([name, path]) => [name, chunkFilesFor(outputs, path)])
        );
        // A JSON string body is a valid body of any JS string literal here
        // (file names hold no backtick or `${`).
        const body = JSON.stringify(JSON.stringify(lists)).slice(1, -1);
        if (body.length > CHUNK_PREFETCH_SLOT) {
          const perList = Object.entries(lists)
            .map(([name, files]) => `${name}: ${files.length} files, ${JSON.stringify(files).length} chars`)
            .join('; ');
          throw new Error(
            `chunk prefetch lists (${body.length} chars) exceed CHUNK_PREFETCH_SLOT (${CHUNK_PREFETCH_SLOT}); ${perList}\n${JSON.stringify(lists, null, 1)}`
          );
        }
        const filled = body + ' '.repeat(CHUNK_PREFETCH_SLOT - body.length);
        let replaced = 0;
        for (const output of Object.values(outputs)) {
          if (output.type !== 'chunk' || !output.code?.includes(SLOT)) continue;
          output.code = output.code.split(SLOT).join(filled);
          replaced += 1;
        }
        if (replaced === 0 && Object.values(outputs).some((output) => output.type === 'chunk')) {
          // The module is imported by the phone warm-up; losing it would turn the
          // warm-up into a silent no-op.
          this.warn(`${CHUNK_PREFETCH_MODULE} was not found in the bundle; phone pane prefetch is empty.`);
        }
      },
    },
  };
}
