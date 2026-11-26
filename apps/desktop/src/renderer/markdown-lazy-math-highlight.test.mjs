import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const rendererDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(rendererDir, '../..');

function findClass(node, className) {
  if (!node || typeof node !== 'object') return false;
  const classes = node.properties?.className;
  if (Array.isArray(classes) && classes.includes(className)) return true;
  if (Array.isArray(node.children)) {
    return node.children.some((child) => findClass(child, className));
  }
  return false;
}

test('markdown loads math only for math text (including blockquotes and lists), shares one lowlight engine with diffs, and loads extra diff grammars on demand', async () => {
  const astModule = await import('./markdown-ast.ts');
  const clientModule = await import('./markdown-worker-client.ts');
  const lowlightModule = await import('./shared-lowlight.ts');
  const extraLowlightModule = await import('./shared-lowlight-extra.ts');
  const diffLowlightModule = await import('./shared-diff-lowlight.ts');

  // Non-math markdown (including prose with single `$`) must not load math or lowlight.
  assert.equal(astModule.isMarkdownMathLoaded(), false, 'math plugins must not load at module import');
  assert.equal(
    lowlightModule.isSharedLowlightInitialized(),
    false,
    'lowlight must not initialize until highlighted code runs'
  );

  await clientModule.preloadSyncMarkdownParser();
  const proseRoot = await clientModule.parseStreamingMarkdownAst('Cost is $5 and $PATH stays **plain**.');
  assert.equal(astModule.isMarkdownMathLoaded(), false, 'prose without math leaves math plugins unloaded');
  assert.equal(
    lowlightModule.isSharedLowlightInitialized(),
    false,
    'prose without fenced code leaves lowlight unloaded'
  );
  assert.equal(findClass(proseRoot, 'katex'), false);

  // Highlighted fenced code initializes the single shared lowlight instance used by diffs too.
  const codeRoot = await clientModule.parseStreamingMarkdownAst('```ts\nconst answer: number = 42;\n```');
  assert.equal(lowlightModule.isSharedLowlightInitialized(), true);
  assert.equal(findClass(codeRoot, 'hljs'), true);
  assert.equal(findClass(codeRoot, 'hljs-keyword'), true);
  assert.equal(
    diffLowlightModule.sharedDiffHighlighter.getHighlighterEngine(),
    lowlightModule.getSharedLowlight(),
    'DiffView and Markdown share the exact same lowlight instance'
  );
  const diffAst = diffLowlightModule.sharedDiffHighlighter.getAST('const answer = 42;', 'sample.ts', 'ts');
  assert.ok(diffAst && Array.isArray(diffAst.children) && diffAst.children.length > 0);
  assert.equal(astModule.isMarkdownMathLoaded(), false, 'highlighted code still leaves math plugins unloaded');

  // Non-common diff grammars stay unloaded at startup and load individually on demand.
  const lowlight = lowlightModule.getSharedLowlight();
  for (const lang of ['powershell', 'dockerfile', 'vue', 'dart', 'elixir', 'scala', 'cmake']) {
    assert.equal(lowlight.registered(lang), false, `${lang} must not be loaded eagerly`);
  }

  // Loading PowerShell (.ps1) loads only powershell, leaving unrelated extra languages unloaded.
  assert.equal(await extraLowlightModule.ensureSharedLowlightLanguage('ps1', 'deploy.ps1'), true);
  assert.equal(lowlight.registered('powershell'), true);
  assert.equal(lowlight.registered('ps1'), true);
  assert.equal(lowlight.registered('dart'), false, 'loading ps1 must not load unrelated grammars');
  const psAst = diffLowlightModule.sharedDiffHighlighter.getAST(
    'function Invoke-Task { Write-Host "ok" }',
    'deploy.ps1',
    'ps1'
  );
  assert.equal(findClass(psAst, 'hljs-keyword'), true, 'ps1 diff highlights after on-demand load');

  // Dockerfile (including nested paths), Vue, Dart, Elixir, Scala, and CMake all load on demand.
  const extraSamples = [
    { fileName: 'docker/Dockerfile', lang: 'docker/Dockerfile', code: 'FROM node:22-alpine\nRUN npm ci\n' },
    {
      fileName: 'App.vue',
      lang: 'vue',
      code: '<template><div>hi</div></template>\n<script lang="ts">\nconst n = 1;\n</script>\n',
    },
    { fileName: 'main.dart', lang: 'dart', code: 'void main() { final x = 1; }\n' },
    { fileName: 'lib/app.ex', lang: 'ex', code: 'defmodule App do\n  def run, do: :ok\nend\n' },
    { fileName: 'Main.scala', lang: 'scala', code: 'object Main { val x = 1 }\n' },
    { fileName: 'CMakeLists.txt', lang: 'txt', code: 'cmake_minimum_required(VERSION 3.20)\nproject(Demo)\n' },
  ];
  for (const sample of extraSamples) {
    assert.equal(
      await extraLowlightModule.ensureSharedLowlightLanguage(sample.lang, sample.fileName),
      true,
      sample.fileName
    );
    assert.equal(diffLowlightModule.sharedDiffHighlighter.hasRegisteredCurrentLang(sample.lang), true, sample.fileName);
    const ast = diffLowlightModule.sharedDiffHighlighter.getAST(sample.code, sample.fileName, sample.lang);
    assert.ok(ast && Array.isArray(ast.children) && ast.children.length > 0, `${sample.fileName} produces AST`);
    assert.equal(
      findClass(ast, 'hljs-keyword') || findClass(ast, 'hljs-name'),
      true,
      `${sample.fileName} highlights tokens`
    );
  }
  const versioned = diffLowlightModule.createVersionedDiffHighlighter(1);
  assert.equal(versioned.name, 'lowlight-v1');

  // Math text loads remark-math and rehype-katex on demand.
  assert.equal(clientModule.canSyncParseMarkdown('$$\nx = 1\n$$'), false, 'unloaded math cannot sync-parse yet');
  const mathRoot = await clientModule.parseStreamingMarkdownAst('$$\n\\frac{a}{b}\n$$');
  assert.equal(astModule.isMarkdownMathLoaded(), true, 'math text loads math plugins on demand');
  assert.equal(findClass(mathRoot, 'katex'), true, 'math renders KaTeX AST');
  assert.equal(clientModule.canSyncParseMarkdown('$$\nx = 1\n$$'), true, 'subsequent math can sync-parse');

  // Fenced math blocks are detected at top-level, inside blockquotes, and inside ordered/unordered lists.
  const fencedMathCases = [
    '```math\na + b\n```',
    '> ```math\n> a + b\n> ```',
    '> > ~~~math\n> > c + d\n> > ~~~',
    '- ```math\n  x + y\n  ```',
    '* ```math\n  x + y\n  ```',
    '+ ~~~math\n  x + y\n  ~~~',
    '1. ```math\n   x + y\n   ```',
    '2) ~~~math\n   x + y\n   ~~~',
    '> - 1. ```math\n>      x + y\n>      ```',
  ];
  for (const sample of fencedMathCases) {
    assert.equal(astModule.containsMarkdownMath(sample), true, `detects math in: ${sample}`);
    const parsed = await astModule.parseMarkdownToHastAsync(sample);
    assert.equal(findClass(parsed, 'katex'), true, `renders KaTeX for: ${sample}`);
  }
  assert.equal(astModule.containsMarkdownMath('> ```markdown\n> plain\n> ```'), false);
  assert.equal(astModule.containsMarkdownMath('- Cost is $5'), false);

  // Verify DiffView and Vite config wire the shared lowlight adapter and on-demand extra grammar loader.
  const diffViewSource = fs.readFileSync(path.join(rendererDir, 'DiffView.lazy.tsx'), 'utf8');
  assert.match(diffViewSource, /ensureSharedLowlightLanguages/);
  assert.match(diffViewSource, /registerHighlighter=\{activeHighlighter\}/);
  const viteConfigSource = fs.readFileSync(path.join(desktopDir, 'electron.vite.config.ts'), 'utf8');
  assert.match(viteConfigSource, /@git-diff-view\\\/lowlight/);
  assert.match(viteConfigSource, /shared-diff-lowlight\.ts/);
});
