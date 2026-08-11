import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import {
  desktopSlashCommandDescription,
  resolveDesktopSlashCommand,
} from './slash-commands.ts';
import { SETTINGS_CATEGORIES } from './settings/settings-items.ts';

const quitAlias = resolveDesktopSlashCommand('q');
assert.equal(quitAlias?.action, 'close-task',
  'Desktop /q must close only the active task.');
assert.equal(desktopSlashCommandDescription(quitAlias), 'Close this task',
  'Desktop /q must not present itself as an app quit command.');
assert.equal(
  SETTINGS_CATEGORIES.find((category) => category.value === 'context')?.items.includes('memory-cycles'),
  false,
  'Desktop settings must expose only the General memory master.',
);

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
    '@fontsource-variable/inter',
    '@fontsource-variable/geist',
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
