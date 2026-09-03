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
    'remark-math',
    'rehype-katex',
    'rehype-highlight',
    'katex',
    'katex/*',
    'lucide-react',
    '@git-diff-view/react',
    '@git-diff-view/react/*',
    '@fontsource-variable/jetbrains-mono',
    '*.css',
    // Vite-only module kinds the electron-vite build resolves natively:
    // `?worker` bundles (monaco workers) and the monaco packages themselves
    // (heavy, syntax-checked by their own package builds).
    '*?worker',
    'monaco-editor',
    'monaco-editor/*',
    '@monaco-editor/react',
  ],
  logLevel: 'warning',
});

console.log('renderer syntax bundle: ok');
