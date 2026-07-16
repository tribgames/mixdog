import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  entryPoints: [fileURLToPath(new URL('./main.tsx', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'esm',
  external: [
    'react',
    'react-dom',
    'react-dom/*',
    'react-markdown',
    'remark-gfm',
    'lucide-react',
    '@git-diff-view/react',
    '@git-diff-view/react/*',
    '@fontsource-variable/inter',
    '@fontsource-variable/jetbrains-mono',
    '*.css',
  ],
  logLevel: 'warning',
});

console.log('renderer syntax bundle: ok');
