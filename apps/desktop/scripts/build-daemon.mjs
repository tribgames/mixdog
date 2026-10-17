import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import { optionValue } from './cli-args.mjs';
import { writeRemoteServerDependencies } from './remote-server-deps.mjs';

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..');
// --outfile: the dev build's own main output (an isolated instance's --outDir).
const outfile = optionValue('outfile') || join(desktopDir, 'out', 'main', 'daemon.cjs');
// Loaded at runtime from node_modules, never bundled; a server install gets
// them from its generated lockfile.
const DAEMON_EXTERNALS = ['@homebridge/node-pty-prebuilt-multiarch'];
// Desktop-host only, never part of a server install: the FFI that file
// downloads ask the OS where an open file lives with on Windows and macOS
// (opened-file-path.ts). The app keeps it unpacked beside daemon.cjs
// (electron-builder asarUnpack); a host without it refuses downloads.
const DESKTOP_HOST_EXTERNALS = ['koffi'];

await build({
  entryPoints: [join(desktopDir, 'src', 'main', 'desktop-service.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  treeShaking: true,
  sourcemap: false,
  external: [...DAEMON_EXTERNALS, ...DESKTOP_HOST_EXTERNALS],
  // The package's UMD main resolves its modules through a runtime require the
  // bundler cannot follow; its ESM build bundles statically.
  alias: { 'jsonc-parser': 'jsonc-parser/lib/esm/main.js' },
  plugins: [
    {
      name: 'plain-node-desktop-service',
      setup(builder) {
        builder.onResolve({ filter: /^electron(?:\/|$)/ }, () => ({
          errors: [{ text: 'daemon service bundle must not import Electron' }],
        }));
      },
    },
  ],
});

// A CJS bundle has no ES export table. Load its real entry under plain Node
// instead of inferring runtime compatibility from generated source text.
const service = createRequire(import.meta.url)(outfile);
if (typeof service.createDesktopService !== 'function') {
  throw new Error('daemon service bundle has no createDesktopService export');
}
console.log(`Built plain-Node desktop service: ${outfile}`);

// The server payload's npm manifest and lockfile (see ssh/remote-install-payload.ts).
const serverDepsDir = writeRemoteServerDependencies({
  rootDir: join(desktopDir, '..', '..'),
  desktopDir,
  // Beside the outfile's out/main, so an isolated build never touches the shared out/.
  outDir: join(dirname(outfile), '..', 'server', 'deps'),
  externals: DAEMON_EXTERNALS,
});
console.log(`Wrote remote server module lockfile: ${serverDepsDir}`);
