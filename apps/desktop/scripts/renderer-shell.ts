import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

type BundleOutput = {
  type: string;
  name?: string;
  fileName: string;
  isEntry?: boolean;
  imports?: string[];
  code?: string;
  source?: string | Uint8Array;
};

/** Vite copies public files without passing them through Rollup's bundle. */
function publicFiles(dir: string, prefix = ''): [string, string][] {
  return readdirSync(dir, { withFileTypes: true }).flatMap<[string, string]>((entry) => {
    const path = join(dir, entry.name);
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) return publicFiles(path, `${name}/`);
    return [[name, createHash('sha256').update(readFileSync(path)).digest('hex')]];
  });
}

/** A document identifies its release and the modules required to start it.
 *  Lazy feature chunks do not have to exist in the phone cache to boot. */
export function stampRendererShell(html: string, bundle: Record<string, BundleOutput>, publicDir?: string): string {
  const assets = new Set<string>();
  const visit = (fileName: string): void => {
    if (assets.has(fileName)) return;
    assets.add(fileName);
    for (const dependency of bundle[fileName]?.imports ?? []) visit(dependency);
  };
  for (const output of Object.values(bundle)) {
    if (
      output.type === 'chunk' &&
      (output.isEntry || ['bootstrap', 'remote-shim', 'i18n', 'mobile-surface'].includes(output.name ?? ''))
    ) {
      visit(output.fileName);
    }
  }
  // Lazy chunks and fixed-name assets can change without a new HTML reference.
  const files = Object.keys(bundle)
    .sort()
    .map((name) => {
      const { code, source } = bundle[name];
      return [
        name,
        createHash('sha256')
          .update(code ?? source ?? '')
          .digest('hex'),
      ];
    });
  const publicAssets = publicDir ? publicFiles(publicDir).sort() : [];
  const version = createHash('sha256')
    .update(JSON.stringify([html, files, publicAssets]))
    .digest('hex');
  return html.replace(
    '</head>',
    [
      `<meta name="mixdog-shell-version" content="${version}">`,
      `<meta name="mixdog-shell-assets" content="${[...assets].join(',')}">`,
      '</head>',
    ].join('')
  );
}
