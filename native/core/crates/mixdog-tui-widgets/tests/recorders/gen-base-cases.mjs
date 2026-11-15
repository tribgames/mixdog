// Writes tests/cases/base.json: the corpus of the base widgets (picker, slash palette, question panel, confirm bar,
// sign-in URL, text entry panel, right hint) and of the pure functions behind them. The cases are generated, not typed,
// so a width, a theme or an index is one more loop turn rather than one more block of JSON.
//
//   node gen-base-cases.mjs > ../cases/base.json

const cases = [];
const U = '__undefined__';
const frame = (id, component, columns, props, extra = {}) => cases.push({ id, kind: 'frame', component, columns, props: { columns, ...props }, ...extra });
const fn = (id, module, name, args) => cases.push({ id, kind: 'fn', module, name, args });

const WIDTHS = [30, 50, 80, 120];
const THEMES = ['basic', 'light', 'dracula'];
const RGB = { ok: 'rgb(80,200,120)', warn: 'rgb(230,180,60)', bad: 'rgb(220,80,80)' };
const items = (count, make = () => ({})) =>
  Array.from({ length: count }, (_, index) => ({ value: `v${index}`, label: `Item ${index}`, description: `Description of item ${index}`, ...make(index) }));
const SPIES = ['onSelect', 'onCancel', 'onHighlight'];

// ---- Picker: widths, themes, every selected index, scrolling --------------------------------------------------------
for (const width of WIDTHS) {
  frame(`picker-basic-w${width}`, 'Picker', width, { title: 'Models', description: 'Choose a model for this session', items: items(4) }, { spies: SPIES });
  frame(`picker-empty-w${width}`, 'Picker', width, { title: '', items: [] }, { spies: SPIES });
  frame(`picker-loading-w${width}`, 'Picker', width, { title: 'Loading', loading: true, items: [] }, { spies: SPIES });
}
for (const theme of THEMES) {
  frame(`picker-theme-${theme}`, 'Picker', 80, { title: 'Theme', description: 'Pick one', items: items(5) }, { theme, spies: SPIES, levels: theme === 'basic' ? true : undefined });
}
for (let index = 0; index < 12; index++) {
  frame(`picker-scroll-${index}`, 'Picker', 80, { title: 'Sessions', items: items(12), initialIndex: index }, { spies: SPIES });
}
for (const width of WIDTHS) {
  frame(`picker-scroll-w${width}`, 'Picker', width, { title: 'Sessions', items: items(30), initialIndex: 17 }, { spies: SPIES });
}
frame('picker-long-labels', 'Picker', 80, {
  title: 'Long',
  items: [
    { value: 'a', label: 'A very long label that does not fit in the label column at all', description: 'short' },
    { value: 'b', label: 'Short', description: 'A very long description that will certainly be truncated at the right edge of the panel' },
  ],
}, { spies: SPIES });
frame('picker-cjk', 'Picker', 50, {
  title: '모델 선택',
  description: '日本語の説明文がここに入ります。とても長い説明です。',
  items: [
    { value: 'a', label: '한국어 라벨입니다', description: '설명이 길면 말줄임표로 잘립니다 설명이 길면' },
    { value: 'b', label: '日本語のラベルがとても長い場合', description: 'テスト' },
    { value: 'c', label: 'mixed 혼합 label', description: 'ok' },
  ],
}, { spies: SPIES });
frame('picker-markers', 'Picker', 80, {
  title: 'Markers',
  items: [
    { value: 'a', label: 'Checked', checked: true, description: 'on' },
    { value: 'b', label: 'Unchecked', checked: false, description: 'off' },
    { value: 'c', label: 'Custom marker', marker: '●', markerColor: RGB.warn },
    { value: 'd', label: 'Plain' },
  ],
}, { spies: SPIES });
frame('picker-meta', 'Picker', 100, {
  title: 'Meta',
  items: [
    { value: 'a', label: 'Alpha', meta: 'meta text', description: 'first' },
    { value: 'b', label: 'Beta', modelProfile: 'profile', description: 'second' },
    { value: 'c', label: '界界abc', metaParts: [{ text: 'abcdef', width: 3 }, { text: 'xy', width: 4 }], description: 'third' },
  ],
}, { spies: SPIES });
frame('picker-meta-width', 'Picker', 100, { title: 'Meta', metaWidth: 10, labelWidth: 14, items: items(3, (i) => ({ meta: `meta ${i} is long` })) }, { spies: SPIES });
frame('picker-suffix', 'Picker', 80, {
  title: 'Suffix',
  items: [
    { value: 'a', label: 'Alpha', labelSuffix: 'recommended', description: 'first' },
    { value: 'b', label: 'Beta', labelSuffix: 'S', labelSuffixColor: RGB.bad, description: 'second' },
    { value: 'c', label: 'A label that is too long for its column', labelSuffix: 'new', description: 'third' },
  ],
  labelWidth: 20,
}, { spies: SPIES });
frame('picker-index-always', 'Picker', 80, { title: 'Index', indexMode: 'always', items: items(3) }, { spies: SPIES });
frame('picker-index-never', 'Picker', 80, { title: 'Index', indexMode: 'never', items: items(20) }, { spies: SPIES });
frame('picker-help', 'Picker', 80, { title: 'Help', help: 'Custom help', items: items(2) }, { spies: SPIES });
frame('picker-help-adjust', 'Picker', 100, { title: 'Adjust', items: items(2) }, { spies: [...SPIES, 'onLeft', 'onRight', 'onTab'] });
frame('picker-visible-3', 'Picker', 80, { title: 'Few', visibleCount: 3, items: items(9), initialIndex: 4 }, { spies: SPIES });
frame('picker-description-multiline', 'Picker', 60, { title: 'Desc', description: 'one line\nanother   line\twith   tabs and a very long tail that has to be cut off somewhere', items: items(2) }, { spies: SPIES });
// footers
frame('picker-footer-string', 'Picker', 80, { title: 'Footer', footer: 'A footer note', items: items(3) }, { spies: SPIES });
frame('picker-footer-lines', 'Picker', 80, {
  title: 'Footer',
  footer: ['plain line', { glyph: '!', color: RGB.warn, text: 'warning line' }, { text: 'object without glyph' }, '', { glyph: '', text: '' }],
  items: items(3),
}, { spies: SPIES });
frame('picker-footer-long', 'Picker', 40, { title: 'Footer', footer: 'A footer note that is much too long for this narrow panel', items: items(3) }, { spies: SPIES });
frame('picker-footer-gap', 'Picker', 80, { title: 'Footer', footer: 'x', footerGapRows: 3, items: items(12) }, { spies: SPIES });
frame('picker-footer-scroll', 'Picker', 80, { title: 'Footer', footer: ['one', 'two'], items: items(20), initialIndex: 9 }, { spies: SPIES });
// confirm bar
const BUTTONS = [{ value: 'back', label: 'Back' }, { value: 'next', label: 'Next' }];
for (const width of [50, 80]) {
  frame(`picker-confirm-w${width}`, 'Picker', width, { title: 'Step', confirmBar: { buttons: BUTTONS }, items: items(3) }, { spies: [...SPIES, 'confirmBar.onConfirm'] });
  frame(`picker-confirm-footer-w${width}`, 'Picker', width, { title: 'Step', footer: 'Footer', confirmBar: { buttons: BUTTONS }, items: items(3) }, { spies: [...SPIES, 'confirmBar.onConfirm'] });
}
frame('picker-confirm-empty', 'Picker', 80, { title: 'Step', confirmBar: { buttons: BUTTONS }, items: [] }, { spies: [...SPIES, 'confirmBar.onConfirm'] });
frame('picker-confirm-loading', 'Picker', 80, { title: 'Step', loading: true, confirmBar: { buttons: BUTTONS }, items: [] }, { spies: [...SPIES, 'confirmBar.onConfirm'] });
frame('picker-confirm-null-button', 'Picker', 80, { title: 'Step', confirmBar: { buttons: [null, ...BUTTONS] }, items: items(2) }, { spies: [...SPIES, 'confirmBar.onConfirm'] });
// fill height
frame('picker-fill', 'Picker', 80, { title: 'Fill', fillHeight: true, items: items(3) }, { rows: 16, spies: SPIES });
frame('picker-fill-footer-confirm', 'Picker', 80, { title: 'Fill', fillHeight: true, footer: 'Footer', confirmBar: { buttons: BUTTONS }, items: items(3) }, { rows: 16, spies: [...SPIES, 'confirmBar.onConfirm'] });
frame('picker-fill-confirm', 'Picker', 80, { title: 'Fill', fillHeight: true, confirmBar: { buttons: BUTTONS }, items: items(3) }, { rows: 16, spies: [...SPIES, 'confirmBar.onConfirm'] });
frame('picker-fill-empty-confirm', 'Picker', 80, { title: 'Fill', fillHeight: true, confirmBar: { buttons: BUTTONS }, items: [] }, { rows: 16, spies: [...SPIES, 'confirmBar.onConfirm'] });
// sign-in URL
const URL_LONG = 'https://auth.example.com/oauth/authorize?response_type=code&client_id=abcdef0123456789&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fcallback&scope=openid+profile&state=xyz';
for (const width of [50, 80, 120]) {
  for (const visibleCount of [8, 5, 3, 2]) {
    frame(`picker-url-w${width}-v${visibleCount}`, 'Picker', width, { title: 'Sign in', description: 'Open the link', detail: URL_LONG, visibleCount, items: items(6) }, { spies: SPIES });
  }
}
frame('picker-url-footer', 'Picker', 80, { title: 'Sign in', detail: URL_LONG, footer: 'Waiting', items: items(2) }, { spies: SPIES });
frame('picker-url-ftp', 'Picker', 80, { title: 'Sign in', detail: 'ftp://files.example.com/a/very/long/path/that/is/not/linked/at/all/file.bin', items: items(2) }, { spies: SPIES });
frame('picker-url-fill', 'Picker', 60, { title: 'Sign in', detail: URL_LONG, fillHeight: true, items: items(2) }, { rows: 18, spies: SPIES });
frame('picker-url-color1', 'Picker', 80, { title: 'Sign in', detail: URL_LONG, items: items(2) }, { spies: SPIES, levels: true });
// keys
const KEYS = { up: '\u001b[A', down: '\u001b[B', left: '\u001b[D', right: '\u001b[C', home: '\u001b[H', end: '\u001b[F', pageUp: '\u001b[5~', pageDown: '\u001b[6~', enter: '\r', tab: '\t', escape: '\u001b', ctrlY: '\u0019', x: 'x' };
const SEQUENCES = {
  'down-down-up': [KEYS.down, KEYS.down, KEYS.up],
  'up-wraps': [KEYS.up],
  'down-wraps': Array(6).fill(KEYS.down),
  'page-keys': [KEYS.pageDown, KEYS.pageDown, KEYS.pageUp],
  'home-end': [KEYS.end, KEYS.home, KEYS.end],
  'enter-escape': [KEYS.down, KEYS.enter, KEYS.escape],
  'left-right-tab': [KEYS.left, KEYS.right, KEYS.tab],
  'other-key': [KEYS.x, KEYS.ctrlY],
};
for (const [name, keys] of Object.entries(SEQUENCES)) {
  frame(`picker-keys-${name}`, 'Picker', 80, { title: 'Keys', items: items(5) }, { keys, spies: [...SPIES, 'onLeft', 'onRight', 'onTab', 'onKey'] });
}
frame('picker-keys-scroll', 'Picker', 80, { title: 'Keys', items: items(30) }, { keys: [KEYS.pageDown, KEYS.pageDown, KEYS.down, KEYS.end, KEYS.pageUp], spies: SPIES });
frame('picker-keys-confirm', 'Picker', 80, { title: 'Step', confirmBar: { buttons: BUTTONS }, items: items(3) }, {
  keys: [KEYS.down, KEYS.down, KEYS.down, KEYS.right, KEYS.left, KEYS.enter, KEYS.down, KEYS.down, KEYS.up, KEYS.up],
  spies: [...SPIES, 'confirmBar.onConfirm'],
});
frame('picker-keys-confirm-tab', 'Picker', 80, { title: 'Step', footer: 'Footer', confirmBar: { buttons: BUTTONS }, items: items(3) }, {
  keys: [KEYS.right, KEYS.right, KEYS.right, KEYS.left, KEYS.left, KEYS.left],
  spies: [...SPIES, 'confirmBar.onConfirm'],
});
frame('picker-keys-url-copy', 'Picker', 80, { title: 'Sign in', detail: 'https://example.com/a', items: items(2) }, { keys: [KEYS.ctrlY], spies: [...SPIES, 'onKey', 'copyText'] });

// ---- ConfirmBar -----------------------------------------------------------------------------------------------------
for (let focused = -1; focused < 3; focused++) {
  frame(`confirm-bar-focus${focused}`, 'ConfirmBar', 60, { buttons: [...BUTTONS, { value: 'skip', label: '건너뛰기' }], focusedIndex: focused });
}
frame('confirm-bar-empty', 'ConfirmBar', 60, { buttons: [] });
frame('confirm-bar-null', 'ConfirmBar', 60, { buttons: [null, { value: 'a', label: 'Only' }, null], focusedIndex: 0 });
frame('confirm-bar-theme', 'ConfirmBar', 60, { buttons: BUTTONS, focusedIndex: 1 }, { theme: 'light', levels: true });
for (const [name, args] of Object.entries({ over: [3, 2], neg: [-1, 2], nan: ['__NaN__', 2], none: [0, 0], mid: [1, 2] })) {
  fn(`confirm-clamp-${name}`, 'confirmBar', 'clampConfirmFocus', args);
}

// ---- SlashCommandPalette ------------------------------------------------------------------------------------------
const commands = (count) =>
  Array.from({ length: count }, (_, i) => ({ name: `cmd${i}`, usage: `/cmd${i}`, description: `Does the thing number ${i} for you`, aliases: i % 3 === 0 ? [`alias${i}`] : [], aliasUsage: i % 3 === 0 ? [`/alias${i}`] : [] }));
for (const width of WIDTHS) {
  frame(`palette-w${width}`, 'SlashCommandPalette', width, { commands: commands(5), selectedIndex: 2 });
  frame(`palette-none-w${width}`, 'SlashCommandPalette', width, { commands: [] });
}
for (const selectedIndex of [0, 3, 7, 11, 19]) {
  frame(`palette-scroll-${selectedIndex}`, 'SlashCommandPalette', 80, { commands: commands(20), selectedIndex });
}
frame('palette-alias-query', 'SlashCommandPalette', 80, { commands: commands(4), selectedIndex: 0, query: 'ali' });
frame('palette-labels', 'SlashCommandPalette', 80, {
  commands: [
    { name: 'mcp', usage: '/mcp', description: 'Manage MCP servers' },
    { name: 'resume', label: 'Resume a session', description: 'Pick from saved sessions' },
    { name: 'x', usage: '//double', description: '' },
    { name: 'noalias', usage: '/noalias', showAliasUsage: false, aliases: ['na'], aliasUsage: ['/na'], description: 'hidden alias usage' },
    { name: 'cjk', usage: '/한국어', description: '한국어 설명이 아주 아주 길어서 잘려야 합니다 한국어 설명이 아주 아주 길어서 잘려야 합니다' },
  ],
  selectedIndex: 1,
  query: 'na',
});
frame('palette-custom-text', 'SlashCommandPalette', 60, { commands: commands(3), title: 'A very long palette title for the row', help: 'long help text that has to be cut to fit the row', description: 'Custom description that is too long for this panel width at all' });
frame('palette-theme', 'SlashCommandPalette', 80, { commands: commands(6), selectedIndex: 1 }, { theme: 'dracula', levels: true });

// ---- ItemRightHintOverprint ---------------------------------------------------------------------------------------
for (const width of [30, 60, 100]) {
  frame(`hint-w${width}`, 'ItemRightHintOverprint', width, { rightMessage: 'saved just now', rightTone: 'info' }, { children: ['body text of the item', 'second row of the item'] });
}
for (const tone of ['error', 'warn', 'cancel', 'plain', 'info']) {
  frame(`hint-tone-${tone}`, 'ItemRightHintOverprint', 60, { rightMessage: 'tone hint', rightTone: tone }, { children: ['body'] });
}
frame('hint-blank', 'ItemRightHintOverprint', 60, { rightMessage: ' \n ' }, { children: ['body'] });
frame('hint-collapse', 'ItemRightHintOverprint', 60, { rightMessage: 'two\n words   here' }, { children: ['body', 'row'] });
frame('hint-truncate', 'ItemRightHintOverprint', 60, { rightMessage: 'a hint that is much too long for its cell', rightMessageWidth: 12 }, { children: ['body'] });
frame('hint-cjk', 'ItemRightHintOverprint', 60, { rightMessage: '저장되었습니다 완료', rightMessageWidth: 10 }, { children: ['본문'] });
frame('hint-width-zero', 'ItemRightHintOverprint', 60, { rightMessage: 'default width', rightMessageWidth: 0 }, { children: ['body'] });
frame('hint-theme', 'ItemRightHintOverprint', 60, { rightMessage: 'colored', rightTone: 'error' }, { children: ['body'], theme: 'light', levels: true });

// ---- SignInUrl ----------------------------------------------------------------------------------------------------
const layout = (compact, hint, label, rows = 3) => ({ compact, hint, label, rows });
for (const width of [40, 80]) {
  frame(`signin-full-w${width}`, 'SignInUrl', width, { url: URL_LONG, layout: layout(false, true, URL_LONG), status: '' });
  frame(`signin-compact-w${width}`, 'SignInUrl', width, { url: URL_LONG, layout: layout(true, true, `${URL_LONG.slice(0, width - 1)}…`, 2) });
  frame(`signin-bare-w${width}`, 'SignInUrl', width, { url: URL_LONG, layout: layout(true, false, `${URL_LONG.slice(0, width - 1)}…`, 1) });
}
for (const status of ['copied', 'sent', 'failed', '']) {
  frame(`signin-status-${status || 'none'}`, 'SignInUrl', 60, { url: URL_LONG, layout: layout(false, true, URL_LONG), status });
}
frame('signin-hidden', 'SignInUrl', 60, { url: URL_LONG, layout: layout(true, false, '', 0) });
frame('signin-blank', 'SignInUrl', 60, { url: '  ', layout: layout(false, true, '') });
frame('signin-ftp', 'SignInUrl', 60, { url: 'ftp://example.com/some/file', layout: layout(false, true, 'ftp://example.com/some/file') });
frame('signin-theme', 'SignInUrl', 60, { url: URL_LONG, layout: layout(false, true, URL_LONG) }, { theme: 'light', levels: true });
for (const [name, [url, columns, rows]] of Object.entries({
  full: [URL_LONG, 80, 10], two: [URL_LONG, 80, 2], one: [URL_LONG, 80, 1], zero: [URL_LONG, 80, 0], neg: [URL_LONG, 80, -4],
  blank: ['   ', 80, 5], inf: [URL_LONG, 30, '__Infinity__'], tiny: [URL_LONG, 1, 5], short: ['https://a.b', 80, 5], cjk: ['https://예시.한국/경로/' + '가'.repeat(60), 40, 2],
})) {
  fn(`signin-layout-${name}`, 'signInUrlLayout', 'signInUrlLayout', [url, columns, rows]);
}

// ---- QuestionPanel ------------------------------------------------------------------------------------------------
const option = (label, description = '') => ({ label, description });
const Q1 = { question: 'Which database should the project use?', header: 'Database', options: [option('PostgreSQL', 'Reliable relational store with strong consistency'), option('SQLite', 'Embedded, zero configuration'), option('MongoDB', 'Document store')], recommended: 0 };
const Q2 = { question: 'Which features do you want?', header: 'Features', multi_select: true, options: [option('Auth', 'Login and sessions'), option('Billing'), option('Search', 'Full text search across everything you have stored in the database'), option('Admin panel')] };
const Q3 = { question: '언어를 선택하세요. 아주 긴 질문 문장이 여러 줄로 나뉘어 표시되어야 합니다 이 문장은 충분히 깁니다.', options: [option('한국어', '기본값'), option('日本語', '日本語の説明がここに入ります'), option('English')], recommended: 2 };
const MANY = { question: 'Pick a number', options: Array.from({ length: 14 }, (_, i) => option(`Number ${i + 1}`, `The number ${i + 1}`)) };
const questionSets = { single: [Q1], multi: [Q2], two: [Q1, Q2], three: [Q1, Q2, Q3], cjk: [Q3], many: [MANY] };
for (const [name, questions] of Object.entries(questionSets)) {
  for (const width of [30, 50, 80, 120]) {
    frame(`question-${name}-w${width}`, 'QuestionPanel', width, { questions }, { spies: ['onSubmit', 'onDismiss'] });
  }
}
for (const rows of [10, 12, 16]) {
  frame(`question-many-rows${rows}`, 'QuestionPanel', 60, { questions: [MANY], rows }, { spies: ['onSubmit', 'onDismiss'] });
  frame(`question-many-rows${rows}-cursor`, 'QuestionPanel', 60, { questions: [MANY], rows }, { keys: Array(8).fill(KEYS.down), spies: ['onSubmit', 'onDismiss'] });
}
frame('question-long-q-rows', 'QuestionPanel', 40, { questions: [{ question: 'word '.repeat(60), options: [option('A'), option('B')] }], rows: 10 }, { spies: ['onSubmit', 'onDismiss'] });
const QKEYS = {
  digits: ['2', '1'],
  arrows: [KEYS.down, KEYS.down, KEYS.down, KEYS.up],
  multi: [' ', KEYS.down, ' ', ' ', '4'],
  'two-questions': ['2', KEYS.enter, KEYS.right, KEYS.left],
  'enter-last': ['1', KEYS.enter],
  'type-custom': ['4', KEYS.enter, 'h', 'i', ' ', 'there', KEYS.enter],
  'type-escape': [KEYS.down, KEYS.down, KEYS.down, KEYS.enter, 'abc', KEYS.escape],
  'type-backspace': [KEYS.down, KEYS.down, KEYS.down, KEYS.enter, 'abc', '\u007f', '\u007f'],
  'type-long': [KEYS.down, KEYS.down, KEYS.down, KEYS.enter, 'x'.repeat(90)],
  dismiss: [KEYS.escape],
  'mouse-report': ['\u001b[<0;10;5M', '[?1;0c'],
};
for (const [name, keys] of Object.entries(QKEYS)) {
  frame(`question-keys-${name}-single`, 'QuestionPanel', 60, { questions: [Q1] }, { keys, spies: ['onSubmit', 'onDismiss'] });
  frame(`question-keys-${name}-multi`, 'QuestionPanel', 60, { questions: [Q2, Q1] }, { keys, spies: ['onSubmit', 'onDismiss'] });
}
frame('question-theme', 'QuestionPanel', 70, { questions: [Q1, Q2] }, { theme: 'dracula', keys: ['1'], spies: ['onSubmit', 'onDismiss'], levels: true });
for (const [name, args] of Object.entries({
  draft: [Q2, { selected: [2, 0, 0, 9, -1], text: '  note  ' }],
  empty: [Q2, { selected: [], text: '   ' }],
  textOnly: [Q1, { selected: [], text: 'custom' }],
  none: [Q1, null],
})) {
  fn(`question-answer-${name}`, 'questionModel', 'answerFor', args);
}
fn('question-answers', 'questionModel', 'buildAnswers', [[Q1, Q2], [{ selected: [1], text: '' }, { selected: [0, 3], text: 'x' }]]);
for (const width of [10, 30, 80]) {
  for (const [name, question] of Object.entries({ Q1, Q2, Q3, MANY })) {
    fn(`question-layout-${name}-w${width}`, 'questionModel', 'optionLayout', [question, width]);
  }
}
for (const rows of ['__Infinity__', 5, 8, 10, 14]) {
  for (const cursor of [0, 5, 14]) {
    fn(`question-plan-r${rows}-c${cursor}`, 'questionModel', 'planQuestionView', [MANY, 40, rows, cursor]);
  }
  fn(`question-plan-q3-r${rows}`, 'questionModel', 'planQuestionView', [Q3, 30, rows, 1]);
}
for (const width of [20, 60]) {
  fn(`question-panel-rows-w${width}`, 'questionModel', 'questionPanelRows', [[Q1, Q2, Q3], width]);
}
fn('question-panel-rows-empty', 'questionModel', 'questionPanelRows', [[], 60]);
for (const question of [Q1, Q2, Q3, { options: [option('a')], recommended: 5 }, { options: [], recommended: 0 }]) {
  fn(`question-cursor-${cases.length}`, 'questionModel', 'initialCursor', [question]);
}
for (const [multi, typing, last, count, questionCount] of [[false, true, false, 3, 1], [true, false, true, 3, 1], [false, false, false, 4, 2], [true, false, false, 2, 3], [false, false, true, 9, 1]]) {
  fn(`question-help-${cases.length}`, 'questionModel', 'questionHelp', [{ multi, typing, last, count, questionCount }]);
}
fn('question-append-capped', 'questionModel', 'appendCapped', ['a'.repeat(3999), 'bc']);
fn('question-append-astral', 'questionModel', 'appendCapped', ['a'.repeat(3999), '😀x']);
fn('question-append-normal', 'questionModel', 'appendCapped', ['abc', 'def']);

// ---- TextEntryPanel -----------------------------------------------------------------------------------------------
const SPIES_TEXT = ['onSubmit', 'onCancel', 'onContentRowsChange'];
for (const width of WIDTHS) {
  frame(`text-single-w${width}`, 'TextEntryPanel', width, { title: 'Name', hint: 'Enter a name', initialValue: 'hello world' }, { spies: SPIES_TEXT });
  frame(`text-empty-w${width}`, 'TextEntryPanel', width, { title: 'Name', hint: '' }, { spies: SPIES_TEXT });
  frame(`text-long-w${width}`, 'TextEntryPanel', width, { title: 'Name', hint: 'Long value', initialValue: 'x'.repeat(150) }, { spies: SPIES_TEXT });
  frame(`text-multi-w${width}`, 'TextEntryPanel', width, { title: 'Notes', multiline: true, initialValue: 'line one\nline two is a bit longer than the first\n\nlast' }, { spies: SPIES_TEXT });
}
frame('text-mask', 'TextEntryPanel', 60, { title: 'API key', mask: true, hint: 'Paste the key', initialValue: 'sk-secret-value' }, { spies: SPIES_TEXT });
frame('text-mask-multi', 'TextEntryPanel', 40, { title: 'API key', mask: true, multiline: true, initialValue: 'sk-secret\nsecond-line-of-the-secret-value-that-wraps' }, { spies: SPIES_TEXT });
frame('text-newline-glyph', 'TextEntryPanel', 60, { title: 'Single', initialValue: 'first\nsecond\nthird' }, { spies: SPIES_TEXT });
frame('text-cjk', 'TextEntryPanel', 40, { title: '이름', hint: '이름을 입력하세요', initialValue: '한국어 日本語 입력 테스트 문장입니다 아주 긴 문장' }, { spies: SPIES_TEXT });
frame('text-multi-cjk', 'TextEntryPanel', 30, { title: '메모', multiline: true, initialValue: '한국어 日本語 입력 테스트 문장입니다 아주 긴 문장\n둘째 줄' }, { spies: SPIES_TEXT });
frame('text-multi-max-rows', 'TextEntryPanel', 40, { title: 'Notes', multiline: true, maxContentRows: 3, initialValue: Array.from({ length: 9 }, (_, i) => `row ${i}`).join('\n') }, { spies: SPIES_TEXT });
frame('text-multi-wrap-flush', 'TextEntryPanel', 20, { title: 'Notes', multiline: true, initialValue: 'a'.repeat(14) }, { spies: SPIES_TEXT });
frame('text-multi-wrap-flush2', 'TextEntryPanel', 20, { title: 'Notes', multiline: true, initialValue: 'a'.repeat(28) }, { spies: SPIES_TEXT });
frame('text-label', 'TextEntryPanel', 60, { title: 'Label', promptLabel: 'URL: ', actionLabel: 'connect', initialValue: 'abc' }, { spies: SPIES_TEXT });
frame('text-label-empty', 'TextEntryPanel', 60, { title: 'Label', promptLabel: '', actionLabel: '  ', initialValue: 'abc' }, { spies: SPIES_TEXT });
frame('text-hint-multiline', 'TextEntryPanel', 50, { title: 'Hint', hint: 'first line\nsecond   line\twith a very long tail that is cut off at the edge', initialValue: 'v' }, { spies: SPIES_TEXT });
for (const width of [50, 80]) {
  frame(`text-url-w${width}`, 'TextEntryPanel', width, { title: 'Paste code', hint: 'Open the link and paste the code', detail: URL_LONG, initialValue: '' }, { spies: SPIES_TEXT });
  frame(`text-url-rows2-w${width}`, 'TextEntryPanel', width, { title: 'Paste code', detail: URL_LONG, urlMaxRows: 2 }, { spies: SPIES_TEXT });
  frame(`text-url-rows1-w${width}`, 'TextEntryPanel', width, { title: 'Paste code', hint: 'hint', detail: URL_LONG, urlMaxRows: 1 }, { spies: SPIES_TEXT });
  frame(`text-url-rows0-w${width}`, 'TextEntryPanel', width, { title: 'Paste code', hint: 'hint', detail: URL_LONG, urlMaxRows: 0 }, { spies: SPIES_TEXT });
}
frame('text-theme', 'TextEntryPanel', 60, { title: 'Name', hint: 'hint', initialValue: 'themed' }, { theme: 'light', spies: SPIES_TEXT, levels: true });
// A selection: shift+left three times from the end. The Rust side renders the draft the keys leave (the editing itself is
// the editor's), so the case says which draft that is.
const SHIFT_LEFT = '\u001b[1;2D';
frame('text-selection-single', 'TextEntryPanel', 60, { title: 'Name', initialValue: 'hello world' }, { keys: [SHIFT_LEFT, SHIFT_LEFT, SHIFT_LEFT], spies: SPIES_TEXT, draftAfterKeys: { cursor: 8, selectionAnchor: 11 } });
frame('text-selection-multi', 'TextEntryPanel', 40, { title: 'Notes', multiline: true, initialValue: 'one two three\nfour five six\nseven' }, { keys: [SHIFT_LEFT, SHIFT_LEFT, SHIFT_LEFT, SHIFT_LEFT, SHIFT_LEFT, SHIFT_LEFT, SHIFT_LEFT], spies: SPIES_TEXT, draftAfterKeys: { cursor: 26, selectionAnchor: 33 } });
frame('text-caret-middle', 'TextEntryPanel', 60, { title: 'Name', initialValue: 'hello world' }, { keys: ['\u001b[D', '\u001b[D', '\u001b[D'], spies: SPIES_TEXT, draftAfterKeys: { cursor: 8, selectionAnchor: null } });
frame('text-caret-middle-long', 'TextEntryPanel', 30, { title: 'Name', initialValue: 'x'.repeat(60) }, { keys: Array(20).fill('\u001b[D'), spies: SPIES_TEXT, draftAfterKeys: { cursor: 40, selectionAnchor: null } });
for (const [name, args] of Object.entries({
  short: ['abc', 3, 10], end: ['abcdefghij', 10, 5], mid: ['abcdefghij', 2, 5], late: ['abcdefghij', 8, 5], wide: ['日本語テキスト', 14, 5], wideMid: ['日本語テキスト', 4, 7],
  emoji: ['a😀b😀c', 5, 4], one: ['abc', 2, 1], zero: ['', 0, 5], flat: ['a⏎b⏎c', 3, 3],
})) {
  fn(`text-window-${name}`, 'textEntryLayout', 'windowSingleLine', args);
}
fn('text-flatten', 'textEntryLayout', 'flattenForSingleLine', ['a\nb\n\nc']);
fn('text-single-line', 'textEntryLayout', 'singleLine', [' two\n  lines\t here ']);
for (const [name, args] of Object.entries({ plain: ['abc', 10], empty: ['', 10], exact: ['abcde', 5], wrap: ['abcdef', 5], newline: ['ab\ncd\n', 5], wide: ['日本語', 5], tiny: ['abc', 0], long: ['x'.repeat(100), 7], emoji: ['a😀😀😀b', 4], combining: ['ééé', 2] })) {
  fn(`layout-rows-${name}`, 'textLayout', 'wrappedTextRows', args);
}
for (const [name, args] of Object.entries({ plain: ['abcdefghij', 4], blank: ['   ', 4], words: ['hello wonderful world of terminals', 8], url: [URL_LONG, 30], cjk: ['日本語のテキスト', 5] })) {
  fn(`layout-detail-${name}`, 'textLayout', 'wrappedDetailRows', args);
}
for (const [scroll, visible] of [[0, 1], [1, 1], [1, 2], [2, 5], [9, 2]]) {
  fn(`layout-window-${scroll}-${visible}`, 'textLayout', 'sliceVisualRowWindow', ['abcdefghij\nklm\n\nnopqrstuvwxyz', 4, scroll, visible]);
}
fn('layout-reserved', 'textLayout', 'textEntryReservedRows', ['abcd', 4, 8]);
fn('layout-reserved-cap', 'textLayout', 'textEntryReservedRows', ['abcd\nabcd\nabcd', 4, 2]);
for (const [name, args] of Object.entries({ start: ['abcdef', 0, 5, U], end: ['abcde', 5, 5, U], endTrailing: ['abcde', 5, 5, true], wrapMid: ['abcdefg', 5, 5, U], newline: ['ab\ncd', 4, 5, U], wide: ['日本語', 4, 5, U], emoji: ['a😀b', 3, 4, U], explicitFalse: ['abcde', 5, 5, false] })) {
  fn(`caret-${name}`, 'inputEditing', 'caretPosition', args);
}
for (const [name, args] of Object.entries({ plain: ['abc'], newline: [' \n '], inner: ['two\n words'], tabs: ['  a \t b  '], none: [''] })) {
  fn(`clean-right-${name}`, 'appFormat', 'cleanRightMessage', args);
}
for (const [name, args] of Object.entries({
  label0: [0, 80], label40: [40, 80], labelNarrow: [30, 20], labelDefault: [U, 80], labelNaN: ['__NaN__', 80],
})) {
  fn(`picker-clamp-label-${name}`, 'pickerLayout', 'clampLabelWidth', args);
}
fn('picker-clamp-meta-a', 'pickerLayout', 'clampMetaWidth', [U, 100, 28]);
fn('picker-clamp-meta-b', 'pickerLayout', 'clampMetaWidth', [40, 60, 28]);
fn('picker-clamp-meta-c', 'pickerLayout', 'clampMetaWidth', [10, 30, 28]);
fn('picker-clamp-index-a', 'pickerLayout', 'clampItemIndex', [9, 3]);
fn('picker-clamp-index-b', 'pickerLayout', 'clampItemIndex', [2, 0]);
fn('picker-clamp-index-c', 'pickerLayout', 'clampItemIndex', [-4, 5]);
fn('picker-clamp-index-d', 'pickerLayout', 'clampItemIndex', [null, 5]);
for (const [name, args] of Object.entries({ plain: ['abc', 3], cut: ['abcdef', 4], one: ['abcdef', 1], zero: ['abcdef', 0], wide: ['日本語', 4], wideFit: ['日本語', 6], empty: ['', 3], emoji: ['a😀😀b', 4], combining: ['éééé', 3] })) {
  fn(`cell-truncate-${name}`, 'panelCellText', 'truncatePanelText', args);
  fn(`cell-pad-${name}`, 'panelCellText', 'padPanelCells', args);
}

process.stdout.write(`${JSON.stringify(cases, null, 1)}\n`);
