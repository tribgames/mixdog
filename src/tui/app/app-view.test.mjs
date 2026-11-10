import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import { build } from 'esbuild';
import React from 'react';
import { render } from 'ink';

const directory = mkdtempSync(resolve('.tmp-app-view-test-'));
let components;
before(async () => {
  const output = join(directory, 'app-view.mjs');
  await build({
    stdin: {
      contents: [
        "export { renderAppView } from './src/tui/app/app-view.jsx';",
        ...[
          'Picker',
          'ContextPanel',
          'UsagePanel',
          'SlashCommandPalette',
          'TextEntryPanel',
          'PromptInput',
          'Spinner',
          'QueuedCommands',
        ].map((name) => `export { ${name} } from './src/tui/components/${name}.jsx';`),
      ].join('\n'),
      resolveDir: process.cwd(),
    },
    outfile: output,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    plugins: [
      {
        name: 'keep-runtime-module-paths',
        setup(builder) {
          builder.onResolve({ filter: /^\.\.?\/.*\.mjs$/ }, (args) => ({
            path: pathToFileURL(resolve(args.resolveDir, args.path)).href,
            external: true,
          }));
        },
      },
    ],
  });
  components = await import(pathToFileURL(output).href);
});
after(() => rmSync(directory, { recursive: true, force: true }));

const noop = () => {};
function context(overrides = {}) {
  return {
    PANEL_MAX_VISIBLE: 8,
    frameColumns: 120,
    resizeState: { rows: 30 },
    state: { busy: false, queued: [], items: [], cwd: 'C:/view-test', provider: 'openai', model: 'test-model' },
    statuslineStats: {},
    initialStatusLine: 'Ready',
    transcriptWindow: { effectiveScrollOffset: 0, startIndex: 0, bottomSpacerRows: 0 },
    renderedTranscriptItems: [],
    viewportHeight: 0,
    transcriptContentHeight: 0,
    floatingPanelRows: 12,
    inputBoxHidden: true,
    slashCommands: [],
    slashPaletteOpen: false,
    providerPrompt: null,
    settingsPrompt: null,
    onSubmit: noop,
    cancelProviderPrompt: noop,
    cancelSettingsPrompt: noop,
    setTextEntryLayoutRows: noop,
    ...overrides,
  };
}

function elements(node) {
  if (!React.isValidElement(node)) return [];
  return [node, ...React.Children.toArray(node.props.children).flatMap(elements)];
}

function textEntry(ctx) {
  return elements(components.renderAppView(ctx)).find((node) => node.type === components.TextEntryPanel);
}

function mountView(t, { accepted = true } = {}) {
  const stdout = new PassThrough();
  stdout.columns = 120;
  stdout.rows = 30;
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = noop;
  stdin.ref = noop;
  stdin.unref = noop;
  let screen = '';
  stdout.on('data', (chunk) => {
    screen = stripVTControlCharacters(String(chunk));
  });
  const submitted = [];
  const canceled = [];
  const base = {
    onSubmit: (value) => {
      submitted.push(value);
      return accepted;
    },
    cancelProviderPrompt: () => canceled.push('provider'),
    cancelSettingsPrompt: () => canceled.push('settings'),
  };
  const view = render(components.renderAppView(context(base)), {
    stdout,
    stdin,
    stderr: stdout,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  t.after(() => {
    view.unmount();
    stdin.end();
    stdout.end();
  });
  return {
    submitted,
    canceled,
    screen: () => screen,
    show: async (overrides) => {
      view.rerender(components.renderAppView(context({ ...base, ...overrides })));
      await delay(80);
    },
    send: async (input) => {
      stdin.write(input);
      await delay(80);
    },
  };
}

test('rendered settings accept documented blank resets on Enter and coalesced Enter chunks only', async (t) => {
  const h = mountView(t);
  for (const [kind, allowEmpty] of [
    ['system-shell', true],
    ['autoclear-provider', true],
    ['profile-title', true],
    ['core-add', false],
    ['', false],
  ]) {
    const settingsPrompt = { kind, label: `Field ${kind || 'unknown'}`, hint: 'Enter a value' };
    await h.show({ settingsPrompt });
    assert.ok(h.screen().includes(settingsPrompt.label));
    const start = h.submitted.length;
    await h.send('\r');
    assert.deepEqual(h.submitted.slice(start), allowEmpty ? [''] : []);
    await h.send('   \r');
    assert.deepEqual(h.submitted.slice(start), allowEmpty ? ['', '   '] : []);
    await h.show({ settingsPrompt: { ...settingsPrompt, restoreEpoch: 1 } });
    await h.send('kept\r');
    assert.equal(h.submitted.at(-1), 'kept');
    await h.send('\x1b');
    assert.equal(h.canceled.at(-1), 'settings');
  }
});

test('rendered prompt drafts survive ordinary rerenders and reset on restore epochs', async (t) => {
  const h = mountView(t, { accepted: false });
  for (const field of ['settingsPrompt', 'providerPrompt']) {
    const prompt =
      field === 'settingsPrompt'
        ? { kind: 'profile-title', label: 'Stable field', initialValue: 'seed' }
        : { kind: 'api-key', label: 'Provider', mode: 'replace', initialValue: 'secret' };
    await h.show({ [field]: prompt });
    await h.send('X');
    await h.show({ [field]: prompt, frameColumns: 110 });
    await h.send('\r');
    assert.equal(h.submitted.at(-1), `${prompt.initialValue}X`, 'the editor must not remount on an ordinary render');
    if (field === 'providerPrompt') assert.ok(!h.screen().includes('secret'), 'credentials remain masked');
    await h.show({ [field]: { ...prompt, restoreEpoch: 1 } });
    await h.send('\r');
    assert.equal(h.submitted.at(-1), prompt.initialValue, 'a restore must remount even with unchanged initialValue');
    await h.send('\x1b');
    assert.equal(h.canceled.at(-1), field === 'providerPrompt' ? 'provider' : 'settings');
  }
});

test('settings labels, multiline mode and empty-submit policy retain their kind-specific defaults', () => {
  for (const [kind, actionLabel, promptLabel, multiline, allowEmpty] of [
    ['skill-use', 'run', 'Command > ', false, false],
    ['autoclear-provider', 'save', 'Duration > ', false, true],
    ['project-new', 'open', 'Path > ', false, false],
    ['project-create-confirm', 'confirm', 'Create? (y/n) > ', false, false],
    ['project-rename', 'rename', 'Name > ', false, false],
    ['core-add', 'add', 'Sentence > ', true, false],
    ['core-edit', 'save', 'Sentence > ', true, false],
    ['core-delete-confirm', 'confirm', 'Delete? (y/n) > ', false, false],
    ['system-shell', 'save', 'Value > ', false, true],
    ['profile-title', 'save', 'Value > ', false, true],
    ['__proto__', 'save', 'Value > ', false, false],
  ]) {
    const panel = textEntry(context({ settingsPrompt: { kind, label: 'Settings' } }));
    assert.deepEqual(
      [panel.props.actionLabel, panel.props.promptLabel, panel.props.multiline, panel.props.allowEmpty],
      [actionLabel, promptLabel, multiline, allowEmpty]
    );
  }
});

test('provider labels preserve key, OAuth, usage-session and unknown-kind behavior', () => {
  const cases = [
    [
      {
        kind: 'api-key',
        label: 'OpenAI',
        mode: 'replace',
        envName: 'KEY',
        source: 'stored',
        keyUrl: 'https://keys.test',
      },
      [
        'Replace API key · OpenAI',
        'Env: KEY · Current: stored · Get a key: https://keys.test · Stored in the OS keychain.',
        'API key > ',
        true,
        'save',
      ],
    ],
    [
      { kind: 'api-key', label: 'OpenAI' },
      ['Set API key · OpenAI', 'Stored in the OS keychain.', 'API key > ', true, 'save'],
    ],
    [
      { kind: 'oauth-code', label: 'OAuth' },
      ['OAuth', 'Paste the browser code.', 'Paste code here if prompted > ', false, 'continue'],
    ],
    [
      { kind: 'oauth-code', label: 'OAuth', hint: 'Custom hint' },
      ['OAuth', 'Custom hint', 'Paste code here if prompted > ', false, 'continue'],
    ],
    [
      { kind: 'openai-usage-session' },
      [
        'OpenAI Usage · Session Key',
        'Paste an OpenAI dashboard/session key for the undocumented credit lookup. It is stored in the OS keychain.',
        'Session key > ',
        true,
        'save',
      ],
    ],
    [
      { kind: '__proto__', label: 'Other', defaultURL: 'https://default.test' },
      ['Base URL · Other', 'Default: https://default.test', 'Base URL > ', false, 'save'],
    ],
  ];
  for (const [providerPrompt, expected] of cases) {
    const panel = textEntry(context({ providerPrompt }));
    assert.deepEqual(
      [panel.props.title, panel.props.hint, panel.props.promptLabel, panel.props.mask, panel.props.actionLabel],
      expected
    );
  }
});

test('floating panels retain priority and stay absent when their reserved height is zero', () => {
  const overlays = {
    toolApproval: { id: 'approval', name: 'read', args: {} },
    picker: { title: 'Picker', items: [] },
    contextPanel: { title: 'Context', rows: [] },
    usagePanel: {},
    slashPaletteOpen: true,
    providerPrompt: { kind: 'api-key', label: 'Provider' },
    settingsPrompt: { kind: 'profile-title', label: 'Settings' },
  };
  const types = [
    components.Picker,
    components.Picker,
    components.ContextPanel,
    components.UsagePanel,
    components.SlashCommandPalette,
    components.TextEntryPanel,
    components.TextEntryPanel,
  ];
  for (const [index, field] of Object.keys(overlays).entries()) {
    const nodes = elements(components.renderAppView(context(overlays))).filter((node) => types.includes(node.type));
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].type, types[index]);
    if (field === 'toolApproval') assert.equal(nodes[0].props.title, 'Tool approval');
    if (field === 'providerPrompt') assert.equal(nodes[0].props.title, 'Set API key · Provider');
    if (field === 'settingsPrompt') assert.equal(nodes[0].props.title, 'Settings');
    const hidden = elements(components.renderAppView(context({ ...overlays, floatingPanelRows: 0 })));
    assert.ok(hidden.every((node) => !types.includes(node.type)));
    overlays[field] = null;
  }
});

test('palette navigation retains wrapping, endpoints and numeric clamping', () => {
  let index = 1;
  const ctx = context({
    inputBoxHidden: false,
    slashCommands: [{ name: 'one' }, { name: 'two' }, { name: 'three' }],
    setSlashIndex: (update) => {
      index = update(index);
    },
  });
  const prompt = elements(components.renderAppView(ctx)).find((node) => node.type === components.PromptInput);
  for (const [direction, expected] of [
    ['home', 0],
    ['left', 2],
    ['right', 0],
    ['end', 2],
    [-5, 0],
    [5, 2],
    ['bad', 2],
  ]) {
    prompt.props.onCommandPaletteNavigate(direction);
    assert.equal(index, expected);
  }
  const empty = elements(components.renderAppView({ ...ctx, slashCommands: [] })).find(
    (node) => node.type === components.PromptInput
  );
  empty.props.onCommandPaletteNavigate('end');
  assert.equal(index, 0);
});

test('tool approval resolves select, cancel and a/y/d/n keys into approve/deny decisions', () => {
  const decisions = [];
  const store = { resolveToolApproval: (id, decision) => decisions.push([id, decision]) };
  const approval = elements(
    components.renderAppView(context({ store, toolApproval: { id: 'call-1', name: 'read', args: {} } }))
  ).find((node) => node.type === components.Picker);
  approval.props.onSelect('approve');
  approval.props.onSelect('deny');
  approval.props.onCancel();
  approval.props.onKey(' Y ');
  approval.props.onKey('a');
  approval.props.onKey('n');
  approval.props.onKey('d');
  approval.props.onKey('x');
  const approved = { approved: true, reason: 'approved by user' };
  const denied = { approved: false, reason: 'denied by user' };
  assert.deepEqual(
    decisions.map(([, decision]) => decision),
    [approved, denied, denied, approved, approved, denied, denied]
  );
  assert.ok(decisions.every(([id]) => id === 'call-1'));
});

test('prompt cluster shows the spinner/status row and queued commands only when visible', () => {
  const visible = {
    inputBoxHidden: false,
    promptMetaVisible: true,
    liveSpinner: { verb: 'Thinking', startedAt: 1, tokens: 7 },
    inputHint: 'copied',
    inputHintTone: 'info',
    queuedVisible: true,
    queuedCompact: false,
  };
  const types = (ctx) => elements(components.renderAppView(context(ctx))).map((node) => node.type);
  const shown = types(visible);
  assert.ok(shown.includes(components.Spinner));
  assert.ok(shown.includes(components.QueuedCommands));
  assert.ok(shown.includes(components.PromptInput));
  const spinner = elements(components.renderAppView(context(visible))).find((node) => node.type === components.Spinner);
  assert.equal(spinner.props.outputTokens, 7);
  assert.equal(spinner.props.mode, 'responding');
  const statusText = elements(components.renderAppView(context(visible))).filter(
    (node) => node.props?.children === 'copied'
  );
  assert.equal(statusText.length, 1);
  const quiet = types({ ...visible, promptMetaVisible: false, queuedVisible: false });
  assert.ok(!quiet.includes(components.Spinner));
  assert.ok(!quiet.includes(components.QueuedCommands));
  assert.ok(quiet.includes(components.PromptInput));
  const hidden = types({ ...visible, inputBoxHidden: true });
  assert.ok(!hidden.includes(components.Spinner));
  assert.ok(!hidden.includes(components.QueuedCommands));
  assert.ok(!hidden.includes(components.PromptInput));
});
