import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAppWorkbenchCommands } from './app-workbench-commands.ts';

// Command id → `mixdog:editor-action` detail, in palette order.
const EDITOR_ACTIONS = [
  ['editor.action.toggleWordWrap', 'editor.action.toggleWordWrap'],
  ['editor.action.revealDefinition', 'editor.action.revealDefinition'],
  ['editor.action.peekDefinition', 'editor.action.peekDefinition'],
  ['editor.action.revealDeclaration', 'editor.action.revealDeclaration'],
  ['editor.action.goToTypeDefinition', 'editor.action.goToTypeDefinition'],
  ['editor.action.goToImplementation', 'editor.action.goToImplementation'],
  ['editor.action.goToReferences', 'editor.action.goToReferences'],
  ['editor.action.referenceSearch.trigger', 'editor.action.referenceSearch.trigger'],
  ['editor.action.triggerSuggest', 'editor.action.triggerSuggest'],
  ['editor.action.triggerParameterHints', 'editor.action.triggerParameterHints'],
  ['editor.action.quickOutline', 'editor.action.quickOutline'],
  ['editor.action.rename', 'rename'],
  ['editor.action.changeAll', 'editor.action.changeAll'],
  ['editor.action.quickFix', 'quickFix'],
  ['editor.action.refactor', 'refactor'],
  ['editor.action.sourceAction', 'editor.action.sourceAction'],
  ['editor.action.formatDocument', 'format'],
  ['editor.action.formatDocument.multiple', 'editor.action.formatDocument.multiple'],
  ['editor.action.formatSelection', 'editor.action.formatSelection'],
  ['editor.action.commentLine', 'editor.action.commentLine'],
  ['editor.fold', 'editor.fold'],
  ['editor.unfold', 'editor.unfold'],
  ['editor.showCallHierarchy', 'callHierarchy'],
];

// Editor actions that need only an active file, no language capability.
const CAPABILITY_FREE = new Set([
  'editor.action.toggleWordWrap',
  'editor.action.triggerSuggest',
  'editor.action.quickOutline',
  'editor.action.changeAll',
  'editor.action.commentLine',
  'editor.fold',
  'editor.unfold',
]);

const ALL_CAPABILITIES = {
  definition: true,
  declaration: true,
  typeDefinition: true,
  implementation: true,
  references: true,
  signatureHelp: true,
  rename: true,
  codeAction: true,
  formatting: true,
  rangeFormatting: true,
  callHierarchy: true,
};

function buildCommands(overrides = {}) {
  const noop = () => {};
  return buildAppWorkbenchCommands({
    quickAccessMode: 'commands',
    editorNavigationHistory: { current: { entries: [], index: -1 } },
    navigateEditorHistory: noop,
    setQuickAccessMode: noop,
    chooseFileTab: async () => {},
    activeFileKey: 'file:/project:src/index.ts',
    editorSaveHandles: { current: new Map() },
    dirtyFileKeys: new Set(),
    focusedLeafTabs: [],
    openDockTab: noop,
    bottomPanel: { setTab: noop },
    toggleBottomPanel: noop,
    editorCommandCapabilities: ALL_CAPABILITIES,
    toggleSidebar: noop,
    toggleDock: noop,
    openTerminalTab: noop,
    startTask: noop,
    openStudioTab: noop,
    openSettings: noop,
    ...overrides,
  });
}

function withWindow(run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const target = new EventTarget();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target });
  try {
    return run(target);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete globalThis.window;
  }
}

test('the command palette lists commands only in commands mode', () => {
  assert.deepEqual(buildCommands({ quickAccessMode: null }), []);
  assert.deepEqual(buildCommands({ quickAccessMode: 'files' }), []);
});

test('editor commands dispatch their editor action in palette order', () => {
  withWindow((target) => {
    const details = [];
    target.addEventListener('mixdog:editor-action', (event) => details.push(event.detail));
    const commands = buildCommands();
    const editorIds = new Set(EDITOR_ACTIONS.map(([id]) => id));
    assert.deepEqual(
      commands.filter((command) => editorIds.has(command.id)).map((command) => command.id),
      EDITOR_ACTIONS.map(([id]) => id)
    );
    for (const [id] of EDITOR_ACTIONS) {
      const command = commands.find((candidate) => candidate.id === id);
      assert.equal(command.enabled, true, id);
      command.run();
    }
    assert.deepEqual(
      details,
      EDITOR_ACTIONS.map(([, detail]) => detail)
    );
  });
});

test('editor commands follow the active file and language capabilities', () => {
  const noFile = buildCommands({ activeFileKey: '' });
  for (const [id] of EDITOR_ACTIONS) {
    assert.equal(noFile.find((command) => command.id === id).enabled, false, id);
  }
  const noCapabilities = buildCommands({ editorCommandCapabilities: {} });
  for (const [id] of EDITOR_ACTIONS) {
    assert.equal(noCapabilities.find((command) => command.id === id).enabled, CAPABILITY_FREE.has(id), id);
  }
});
