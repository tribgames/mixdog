import { createHash } from 'node:crypto';

type BundleOutput = {
  type: string;
  name?: string;
  fileName: string;
  isEntry?: boolean;
  imports?: string[];
};

/** A document identifies its release and the modules required to start it.
 *  Lazy feature chunks do not have to exist in the phone cache to boot. */
export function stampRendererShell(html: string, bundle: Record<string, BundleOutput>): string {
  const assets = new Set<string>();
  const visit = (fileName: string): void => {
    if (assets.has(fileName)) return;
    assets.add(fileName);
    for (const dependency of bundle[fileName]?.imports ?? []) visit(dependency);
  };
  for (const output of Object.values(bundle)) {
    if (output.type === 'chunk'
      && (output.isEntry || ['bootstrap', 'remote-shim', 'i18n', 'mobile-surface'].includes(output.name ?? ''))) {
      visit(output.fileName);
    }
  }
  const version = createHash('sha256').update(html).digest('hex');
  return html.replace('</head>', [
    `<meta name="mixdog-shell-version" content="${version}">`,
    `<meta name="mixdog-shell-assets" content="${[...assets].join(',')}">`,
    '</head>',
  ].join(''));
}
