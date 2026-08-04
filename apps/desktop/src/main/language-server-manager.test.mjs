import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  LanguageServerManager,
  languageServerInitializationOptions,
  languageServerRequestParams,
  languageServerSpecFor,
  normalizeLanguageServerCapabilities,
  parseProjectLanguageServerConfig,
} from './language-server-manager.ts';

test('language server capabilities gate real requests and preserve non-document params', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-lsp-'));
  const fixture = fileURLToPath(new URL('./fixtures/language-server-mock.mjs', import.meta.url));
  await writeFile(join(root, 'main.py'), 'main()\n', 'utf8');
  const manager = new LanguageServerManager({
    python: {
      id: 'mock',
      name: 'Mock LSP',
      command: process.execPath,
      args: [fixture],
    },
  });
  try {
    const state = await manager.document('project', root, {
      kind: 'open',
      projectPath: 'project',
      relPath: 'main.py',
      languageId: 'python',
      version: 1,
      content: 'main()\n',
    });
    assert.equal(state.status, 'ready');
    assert.equal(state.capabilities?.completionResolve, true);
    assert.deepEqual(state.capabilities?.completionTriggerCharacters, ['.']);
    assert.equal(state.capabilities?.typeDefinition, true);
    assert.equal(state.capabilities?.implementation, true);
    assert.equal(state.capabilities?.callHierarchy, true);
    assert.equal(state.capabilities?.signatureHelp, true);
    assert.deepEqual(state.capabilities?.signatureHelpTriggerCharacters, ['(']);
    assert.equal(state.capabilities?.declaration, true);
    assert.equal(state.capabilities?.documentHighlight, true);
    assert.equal(state.capabilities?.linkedEditingRange, true);
    assert.equal(state.capabilities?.codeLensResolve, true);
    assert.equal(state.capabilities?.onTypeFormatting, true);
    assert.equal(state.capabilities?.documentLinkResolve, true);
    assert.equal(state.capabilities?.documentColor, true);
    assert.equal(state.capabilities?.foldingRange, true);
    assert.equal(state.capabilities?.selectionRange, true);
    assert.equal(state.capabilities?.semanticTokens, true);
    assert.equal(state.capabilities?.semanticTokensRange, true);
    assert.equal(state.capabilities?.semanticTokensDelta, true);
    assert.deepEqual(state.capabilities?.semanticTokensLegend.tokenTypes, ['function', 'variable']);
    assert.equal(state.capabilities?.inlayHintResolve, true);
    assert.equal(state.capabilities?.formatting, false);
    assert.deepEqual(state.capabilities?.codeActionKinds, [
      'quickfix',
      'refactor',
      'source.organizeImports',
    ]);

    const typeDefinition = await manager.request(
      'project',
      root,
      'main.py',
      'python',
      'textDocument/typeDefinition',
      { position: { line: 0, character: 1 } },
    );
    assert.equal(typeDefinition.status, 'ready');
    assert.equal(typeDefinition.result[0].range.end.character, 4);

    const completion = await manager.request(
      'project',
      root,
      'main.py',
      'python',
      'textDocument/completion',
      { position: { line: 0, character: 1 } },
    );
    assert.equal(completion.result[0].label, 'main');
    const resolvedCompletion = await manager.request(
      'project',
      root,
      'main.py',
      'python',
      'completionItem/resolve',
      completion.result[0],
    );
    assert.equal(resolvedCompletion.result.documentation, 'Resolved completion');

    const signatureHelp = await manager.request(
      'project',
      root,
      'main.py',
      'python',
      'textDocument/signatureHelp',
      { position: { line: 0, character: 4 } },
    );
    assert.equal(signatureHelp.result.signatures[0].label, 'main(value: string)');

    const semanticTokens = await manager.request(
      'project',
      root,
      'main.py',
      'python',
      'textDocument/semanticTokens/full',
      {},
    );
    assert.deepEqual(semanticTokens.result.data, [0, 0, 4, 0, 1]);

    const inlayHints = await manager.request(
      'project',
      root,
      'main.py',
      'python',
      'textDocument/inlayHint',
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 4 },
        },
      },
    );
    assert.equal(inlayHints.result[0].label, ': string');

    const command = await manager.request(
      'project',
      root,
      'main.py',
      'python',
      'workspace/executeCommand',
      { command: 'mock.apply', arguments: [1] },
    );
    assert.deepEqual(command.result, { command: 'mock.apply', arguments: [1] });

    const unsupported = await manager.request(
      'project',
      root,
      'main.py',
      'python',
      'textDocument/formatting',
      { options: { tabSize: 2, insertSpaces: true } },
    );
    assert.equal(unsupported.result, undefined);
    assert.match(unsupported.detail, /does not support/);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('windows cmd language-server shims preserve quoted command lines', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-lsp-cmd-'));
  const fixture = fileURLToPath(new URL('./fixtures/language-server-mock.mjs', import.meta.url));
  const shimDirectory = join(root, 'server fixture');
  const shimBase = join(shimDirectory, 'mock-lsp');
  const shim = `${shimBase}.cmd`;
  await mkdir(shimDirectory, { recursive: true });
  await writeFile(shimBase, '#!/bin/sh\nexit 1\n', 'utf8');
  await writeFile(shim, `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`, 'utf8');
  await writeFile(join(root, 'main.py'), 'main()\n', 'utf8');
  const manager = new LanguageServerManager({
    python: {
      id: 'windows-cmd-mock',
      name: 'Windows CMD Mock LSP',
      command: shimBase,
      args: [],
    },
  });
  try {
    const state = await manager.document('project', root, {
      kind: 'open',
      projectPath: 'project',
      relPath: 'main.py',
      languageId: 'python',
      version: 1,
      content: 'main()\n',
    });
    assert.equal(state.status, 'ready');
    assert.equal(state.capabilities?.typeDefinition, true);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('language server request framing only injects textDocument for textDocument methods', () => {
  assert.deepEqual(
    languageServerRequestParams('file:///main.py', 'textDocument/hover', {
      position: { line: 0, character: 0 },
    }),
    {
      position: { line: 0, character: 0 },
      textDocument: { uri: 'file:///main.py' },
    },
  );
  assert.deepEqual(
    languageServerRequestParams('file:///main.py', 'callHierarchy/incomingCalls', {
      item: { name: 'main' },
    }),
    { item: { name: 'main' } },
  );
});

test('TypeScript LSP uses one bounded semantic server without automatic typings', () => {
  assert.deepEqual(languageServerInitializationOptions({
    id: 'typescript-language-server',
  }), {
    hostInfo: 'mixdog',
    disableAutomaticTypingAcquisition: true,
    maxTsServerMemory: 768,
    tsserver: { useSyntaxServer: 'never' },
  });
  assert.equal(languageServerInitializationOptions({ id: 'custom' }), undefined);
});

test('closing an unopened document does not start its language server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-lsp-close-'));
  const manager = new LanguageServerManager({
    typescript: {
      id: 'never-spawn',
      name: 'Never Spawn',
      command: 'definitely-missing-language-server',
      args: [],
    },
  });
  const statuses = [];
  const unsubscribe = manager.subscribeStatus((state) => statuses.push(state.status));
  try {
    const state = await manager.document('project', root, {
      kind: 'close',
      projectPath: 'project',
      relPath: 'main.ts',
      languageId: 'typescript',
      version: 1,
    });
    assert.equal(state.status, 'stopped');
    assert.deepEqual(statuses, []);
  } finally {
    unsubscribe();
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('capability normalization accepts boolean and option-object providers', () => {
  const capabilities = normalizeLanguageServerCapabilities({
    capabilities: {
      completionProvider: { resolveProvider: true, triggerCharacters: ['.', ':'] },
      definitionProvider: true,
      renameProvider: { prepareProvider: true },
      codeActionProvider: { resolveProvider: true, codeActionKinds: ['quickfix'] },
    },
  });
  assert.equal(capabilities.completionResolve, true);
  assert.deepEqual(capabilities.completionTriggerCharacters, ['.', ':']);
  assert.equal(capabilities.definition, true);
  assert.equal(capabilities.rename, true);
  assert.equal(capabilities.prepareRename, true);
  assert.equal(capabilities.codeActionResolve, true);
  assert.deepEqual(capabilities.codeActionKinds, ['quickfix']);
  assert.equal(capabilities.callHierarchy, false);
  assert.equal(capabilities.signatureHelp, false);
  assert.equal(capabilities.semanticTokens, false);
  assert.deepEqual(capabilities.semanticTokensLegend, {
    tokenTypes: [],
    tokenModifiers: [],
  });
});

test('project LSP registry dynamically overrides defaults and shares a server across languages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-lsp-registry-'));
  const fixture = fileURLToPath(new URL('./fixtures/language-server-mock.mjs', import.meta.url));
  await mkdir(join(root, '.mixdog'), { recursive: true });
  await writeFile(join(root, '.mixdog', 'lsp.json'), JSON.stringify({
    servers: [{
      id: 'project-typescript',
      name: 'Project TypeScript',
      languages: ['typescript', 'javascript'],
      command: process.execPath,
      args: [fixture],
    }],
  }), 'utf8');
  await writeFile(join(root, 'main.ts'), 'main()\n', 'utf8');
  await writeFile(join(root, 'main.js'), 'main()\n', 'utf8');
  const manager = new LanguageServerManager();
  try {
    const typescript = await manager.document('project', root, {
      kind: 'open',
      projectPath: 'project',
      relPath: 'main.ts',
      languageId: 'typescript',
      version: 1,
      content: 'main()\n',
    });
    const javascript = await manager.document('project', root, {
      kind: 'open',
      projectPath: 'project',
      relPath: 'main.js',
      languageId: 'javascript',
      version: 1,
      content: 'main()\n',
    });
    assert.equal(typescript.server, 'Project TypeScript');
    assert.equal(javascript.server, 'Project TypeScript');
    assert.equal(typescript.capabilities?.rename, true);
    assert.equal(javascript.capabilities?.codeAction, true);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('server dynamic registrations update capabilities, requests, and status events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-lsp-dynamic-'));
  const fixture = fileURLToPath(new URL('./fixtures/language-server-dynamic-mock.mjs', import.meta.url));
  await writeFile(join(root, 'main.py'), 'main()\n', 'utf8');
  const manager = new LanguageServerManager({
    python: {
      id: 'dynamic-mock',
      name: 'Dynamic Mock LSP',
      command: process.execPath,
      args: [fixture],
    },
  });
  try {
    const dynamicState = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Dynamic capabilities were not published.')), 3_000);
      const unsubscribe = manager.subscribeStatus((state) => {
        if (state.status !== 'ready' || !state.capabilities?.formatting
          || state.capabilities.rangeFormatting) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(state);
      });
    });
    const initial = await manager.document('project', root, {
      kind: 'open',
      projectPath: 'project',
      relPath: 'main.py',
      languageId: 'python',
      version: 1,
      content: 'main()\n',
    });
    assert.equal(initial.status, 'ready');
    assert.equal(initial.capabilities.codeLens, false,
      'a dynamic documentSelector for another language must not leak into this file');
    assert.equal(initial.capabilities.documentLink, false,
      'a dynamic documentSelector pattern must be evaluated against the actual file');
    const registered = await dynamicState;
    assert.equal(registered.capabilities.formatting, true);
    assert.equal(registered.capabilities.rangeFormatting, false);
    assert.equal(registered.capabilities.codeLens, false);
    assert.equal(registered.capabilities.documentLink, false);

    const formatting = await manager.request(
      'project',
      root,
      'main.py',
      'python',
      'textDocument/formatting',
      { options: { tabSize: 2, insertSpaces: true } },
    );
    assert.equal(formatting.status, 'ready');
    assert.equal(formatting.result[0].newText, 'formatted');

    const removed = await manager.request(
      'project',
      root,
      'main.py',
      'python',
      'textDocument/rangeFormatting',
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } } },
    );
    assert.equal(removed.result, undefined);
    assert.match(removed.detail, /does not support/);
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('project LSP registry validates language mappings and keeps candidates inside the project', () => {
  const root = join(tmpdir(), 'mixdog-lsp-config');
  const parsed = parseProjectLanguageServerConfig({
    servers: [{
      id: 'custom',
      languages: ['custom-language'],
      command: 'custom-lsp',
      args: ['--stdio'],
      candidates: ['tools/custom-lsp'],
    }],
  }, root);
  assert.equal(parsed['custom-language'].command, 'custom-lsp');
  assert.equal(parsed['custom-language'].projectCandidates(root)[0], join(root, 'tools', 'custom-lsp'));
  assert.throws(() => parseProjectLanguageServerConfig({
    servers: [{
      id: 'escape',
      languages: ['custom-language'],
      command: 'custom-lsp',
      candidates: ['../outside'],
    }],
  }, root), /escaped the project/);
  assert.equal(languageServerSpecFor('typescript')?.id, 'typescript-language-server');
  assert.equal(languageServerSpecFor('javascript')?.id, 'typescript-language-server');
});
