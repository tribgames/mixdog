// Writes tests/cases/app_view.json: the composed screens of the terminal UI (an empty session, a streaming turn with the
// spinner and a toast, a picker, a question panel, a plain approval, queued commands, a long transcript scrolled, the slash
// palette, the two text entries, a narrow terminal with a draft that wraps) at 80x24, 120x40 and 60x20, plus the pure
// functions of app-format.mjs and text-entry-labels.mjs the view uses.
//
//   node gen-app-view-cases.mjs > ../cases/app_view.json

const cases = [];
const SIZES = [
  [80, 24],
  [120, 40],
  [60, 20],
];
const screen = (name, scene, extra = {}) => {
  for (const [columns, rows] of SIZES) cases.push({ id: `${name}-${columns}x${rows}`, kind: 'screen', columns, rows, scene, ...extra });
};
const fn = (id, module, name, args) => cases.push({ id, kind: 'fn', module, name, args });

const user = (id, text) => ({ kind: 'user', id, text });
const assistant = (id, text, extra = {}) => ({ kind: 'assistant', id, text, ...extra });
const turnDone = (id) => ({ kind: 'turndone', id, elapsedMs: 12000, status: 'done', verb: 'Thought', toolCount: 0 });

const conversation = [
  user('u1', 'Fix the failing test in the parser and explain what was wrong.'),
  assistant('a1', 'The parser **dropped** the last token when the input ended without a newline.\n\n- the lexer now flushes it\n- a regression test covers it'),
  turnDone('d1'),
  user('u2', 'Thanks. Can you also run the linter?'),
  assistant('a2', 'Running it now.\n\n```sh\nnpm run lint\n```'),
];

const long = [];
for (let n = 0; n < 14; n += 1) {
  long.push(user(`lu${n}`, `Question number ${n}: how does the scheduler decide which worker takes the next job when all of them are idle?`));
  long.push(assistant(`la${n}`, `Answer ${n}: it takes the worker that has been idle the longest, and falls back to the first one when the times are equal.\n\nSee the queue module for the details.`));
  long.push(turnDone(`ld${n}`));
}

screen('empty', { state: { items: [] }, welcomeTip: 'Tip: /model · Pick the right brain for the job.' });
screen('empty-conditional', { state: { items: [] }, welcomeTip: 'Ready when you are.', conditionalWelcomeTip: 'Tip: /providers · Connect a provider before your first turn.' });
screen('conversation-draft', { state: { items: conversation }, promptDraft: 'run the whole suite and\nreport the failures' });
screen('streaming-spinner', {
  state: {
    items: conversation.slice(0, 3).concat([user('u2', 'Thanks. Can you also run the linter?')]),
    busy: true,
    spinner: { active: true, verb: 'Thinking', startedAt: 1_700_000_000_000 - 4200, outputTokens: 120, mode: 'responding' },
    toast: { text: 'Copied selection', tone: 'info' },
  },
});
screen('streaming-assistant', {
  state: {
    items: conversation.slice(0, 4),
    busy: true,
    spinner: { active: true, verb: 'Working', startedAt: 1_700_000_000_000 - 65_000, outputTokens: 4200, mode: 'responding' },
    streamingTail: { id: 'a2', kind: 'assistant', streaming: true, text: 'Running it now.' },
  },
});
screen('queued', {
  state: {
    items: conversation.slice(0, 4),
    busy: true,
    spinner: { active: true, verb: 'Thinking', startedAt: 1_700_000_000_000 - 1500, outputTokens: 0, mode: 'responding' },
    queued: [
      { id: 'q1', text: 'also update the changelog', displayText: 'also update the changelog' },
      { id: 'q2', text: 'and then bump the version number in the manifest, and tag the release when the build is green', displayText: 'and then bump the version number in the manifest, and tag the release when the build is green' },
    ],
  },
});
screen('picker', {
  state: { items: conversation },
  panel: {
    kind: 'picker',
    picker: {
      title: 'Model',
      description: 'Choose the model for this session.',
      help: '↑/↓ Select · Enter Choose · Esc Back',
      items: [
        { value: 'gpt-5', label: 'gpt-5', description: 'the default model' },
        { value: 'gpt-5-mini', label: 'gpt-5-mini', description: 'faster and cheaper' },
        { value: 'claude-sonnet', label: 'claude-sonnet', description: 'balanced' },
        { value: 'local', label: 'local-model', description: 'runs on this machine' },
      ],
      initialIndex: 0,
    },
  },
});
screen('question', {
  state: { items: conversation, busy: true },
  panel: {
    kind: 'question',
    request: {
      kind: 'question',
      name: 'ask_user',
      args: {
        questions: [
          { question: 'Which package manager should the project use?', header: 'Tooling', options: [{ label: 'npm', description: 'the default' }, { label: 'pnpm', description: 'faster installs' }, { label: 'yarn' }] },
        ],
      },
    },
  },
});
screen('approval', {
  state: { items: conversation, busy: true },
  panel: { kind: 'approval', request: { name: 'bash', args: { command: 'rm -rf build && npm run build' }, reason: 'A hook asked for approval.' } },
});
screen('long-scrolled', { state: { items: long }, scrollOffset: 12 });
screen('long-tail', { state: { items: long }, scrollOffset: 0 });
screen('palette', {
  state: { items: conversation },
  promptDraft: '/mo',
  panel: {
    kind: 'palette',
    query: 'mo',
    selected: 1,
    commands: [
      { name: 'model', description: 'Pick the model for this session' },
      { name: 'monitor', description: 'Watch a background job' },
      { name: 'mode', description: 'Switch the workflow mode' },
    ],
  },
});
screen('provider-prompt', {
  state: { items: [] },
  panel: { kind: 'provider-prompt', prompt: { kind: 'api-key', label: 'OpenAI', mode: 'set', envName: 'OPENAI_API_KEY', keyUrl: 'https://platform.openai.com/api-keys', restoreEpoch: 0 } },
});
screen('settings-prompt', {
  state: { items: [] },
  panel: { kind: 'settings-prompt', prompt: { kind: 'project-new', label: 'Open project', hint: 'Type a folder path.', initialValue: 'C:/work', restoreEpoch: 0 } },
});
screen('wide-glyphs', {
  state: { items: [user('wu', '한국어로 질문합니다: 이 함수는 무엇을 하나요?'), assistant('wa', '日本語の答え: この関数は入力を検証します。')] },
  promptDraft: '한글 입력 테스트와 日本語のテキスト',
});

// ---- the pure functions ----------------------------------------------------------------------------------------------
for (const [name, text, columns, reserve] of [
  ['short', 'mixdog', 40, 0],
  ['exact', 'x'.repeat(40), 40, 0],
  ['longer', 'y'.repeat(60), 40, 0],
  ['reserve', 'mixdog coding agent · v1.2.3 · C:/work/project', 80, 4],
  ['cjk', '한국어 제목이 길게 이어집니다 日本語', 20, 0],
  ['narrow', 'abc', 3, 4],
  ['one', 'abcdef', 1, 0],
]) {
  fn(`center-${name}`, 'appFormat', 'centerLine', [text, columns, reserve]);
}
for (const [name, tone] of [['error', 'error'], ['warn', 'warn'], ['cancel', 'cancel'], ['plain', 'plain'], ['info', 'info'], ['none', '']]) {
  fn(`status-color-${name}`, 'appFormat', 'promptStatusColor', [tone]);
}
for (const [name, request] of [
  ['bash', { name: 'bash', args: { command: 'ls -la' }, reason: 'Needs approval.' }],
  ['noreason', { name: 'read', args: { path: 'a.txt' } }],
  ['noargs', { name: 'bash' }],
  ['unnamed', {}],
  ['longargs', { name: 'write', args: { path: 'src/a.rs', content: 'x'.repeat(400) } }],
  ['stringargs', { name: 'bash', args: 'echo   hi\n  there' }],
]) {
  fn(`approval-description-${name}`, 'appFormat', 'toolApprovalDescription', [request]);
}
for (const [name, setup] of [
  ['empty', {}],
  ['api-usable', { api: [{ id: 'a', usable: true }] }],
  ['api-unusable', { api: [{ id: 'a', usable: false }], oauth: [{ id: 'o', usable: false }] }],
  ['local', { local: [{ id: 'l', usable: true }] }],
  ['reauth', { oauth: [{ id: 'o', usable: true, reauthRequired: true }] }],
]) {
  fn(`setup-usable-${name}`, 'appFormat', 'providerSetupHasUsableProvider', [setup]);
}
for (const [name, prompt] of [
  ['api-set', { kind: 'api-key', mode: 'set', label: 'OpenAI', envName: 'OPENAI_API_KEY', source: 'env', keyUrl: 'https://x.example/keys', hint: 'extra' }],
  ['api-replace', { kind: 'api-key', mode: 'replace', label: 'Anthropic' }],
  ['oauth', { kind: 'oauth-code', label: 'Sign in', hint: '' }],
  ['oauth-hint', { kind: 'oauth-code', label: 'Sign in', hint: 'Paste it.' }],
  ['usage', { kind: 'openai-usage-session' }],
  ['base-url', { kind: 'base-url', label: 'Local', defaultURL: 'http://localhost:1234' }],
]) {
  fn(`provider-prompt-fields-${name}`, 'textEntryLabels', 'providerPromptFields', [prompt]);
}
for (const kind of ['skill-use', 'autoclear-provider', 'project-new', 'project-create-confirm', 'project-rename', 'core-add', 'core-edit', 'core-delete-confirm', 'other', '']) {
  fn(`settings-prompt-fields-${kind || 'empty'}`, 'textEntryLabels', 'settingsPromptFields', [kind]);
}

process.stdout.write(`${JSON.stringify(cases, null, 1)}\n`);
