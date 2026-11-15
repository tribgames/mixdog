// Writes tests/cases/transcript.json: the corpus of the transcript components (user, assistant and notice messages, the
// markdown renderer and its streaming tail, ANSI text, completion rows, queued commands, hook-denial cards, the item
// dispatcher) and of the pure rules behind them (applied skills, tool failures). The cases are generated, not typed:
// a width, a theme or a prefix is one more loop turn rather than one more block of JSON.
//
// The rows of the transcript come from the recorded session folds of the desktop (apps/desktop/src/renderer/
// remote-protocol-chat-history.node): every distinct user, assistant and completion row is rendered through the item
// dispatcher at widths 40, 80 and 120, and a few of them under three themes.
//
//   node gen-transcript-cases.mjs > ../cases/transcript.json

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const foldDirectory = resolve(here, '../../../../../../apps/desktop/src/renderer/remote-protocol-chat-history.node');

const cases = [];
const U = '__undefined__';
const frame = (id, component, columns, props, extra = {}) => cases.push({ id, kind: 'frame', component, columns, props, ...extra });
const fn = (id, module, name, args) => cases.push({ id, kind: 'fn', module, name, args });

const WIDTHS = [40, 80, 120];
const THEMES = ['basic', 'light', 'dracula'];

// ---- Markdown samples ----------------------------------------------------------------------------------------------
const MD = {
  headings: '# Heading 1\n\n## Heading 2\n\nSome **bold**, *italic*, `inline code`, and a [link](https://example.com/path).\n\n### Heading 3',
  lists: '- one\n- two\n  - nested a\n  - nested b\n- three\n\n1. first\n2. second\n3. third\n\n- [ ] todo\n- [x] done',
  code: '```js\nconst a = 1;\nfunction f(x) { return x * 2; }\n```\n\nand\n\n```\nplain fence\n```\n\n    indented code line',
  quote: '> quoted line one\n> quoted line two with a [link](https://example.com)\n\n---\n\ntext after the rule',
  tableWide: '| Name | Description | Status |\n|------|-------------|:------:|\n| alpha | The first entry of the table with a long description | ok |\n| beta | Second | **fail** |\n| gamma | `code` cell and more words to wrap around | ok |',
  tableNarrow: '| A | B | C | D | E |\n|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 |\n| long cell one | long cell two | long cell three | long cell four | long cell five |',
  tableCjk: '| 이름 | 설명 |\n|----|----|\n| 하나 | 한국어 설명이 길게 이어집니다 |\n| 二つ | 日本語の説明 |',
  tableEmptyCell: '| A | B |\n|---|---|\n|  | ok |',
  paragraphs: 'A first paragraph that is long enough to wrap around the width of a narrow terminal and keep going.\n\nA second paragraph.\nWith a soft line break inside.',
  cjk: '한국어 문장이 길게 이어질 때 줄바꿈이 올바르게 되는지 확인합니다. 日本語の文章もここに入ります。 emoji 👩‍💻 mixed 😀 text.',
  special: 'a < b && c > d\n\n<div>html</div>\n\nescaped \\*stars\\* and a_snake_case_name and 3 * 4 * 5',
  url: 'https://example.com/a/very/long/path/that/does/not/fit/in/a/narrow/terminal/at/all?with=query&and=more',
  plain: 'plain words that wrap around the available width of the terminal without any markdown',
  empty: '',
  fenceOpen: 'before\n\n```txt\nopen block\nstill open',
};

// ---- AnsiText -------------------------------------------------------------------------------------------------------
const ANSI = {
  bold: '\x1b[1mBold\x1b[22m plain',
  rgb: '\x1b[38;2;1;2;3m界👩‍💻\x1b[39m plain',
  background: '\x1b[48;2;7;8;9mBG\x1b[49m plain',
  cube: '\x1b[38;5;196mred\x1b[39m plain \x1b[48;5;21mBG\x1b[49m',
  ramp: '\x1b[38;5;240mgrey\x1b[0m and \x1b[38;5;16mblack\x1b[0m',
  named: '\x1b[30mk\x1b[31mr\x1b[32mg\x1b[33my\x1b[34mb\x1b[35mm\x1b[36mc\x1b[37mw\x1b[39m',
  bright: '\x1b[90mK\x1b[91mR\x1b[92mG\x1b[93mY\x1b[94mB\x1b[95mM\x1b[96mC\x1b[97mW\x1b[39m',
  indexed16: '\x1b[38;5;1mone\x1b[38;5;5mfive\x1b[38;5;9mnine\x1b[38;5;14mfourteen\x1b[39m',
  namedBackground: '\x1b[41mred\x1b[44mblue\x1b[0m after',
  attributes: '\x1b[1mb\x1b[2md\x1b[3mi\x1b[4mu\x1b[7mv\x1b[0m plain \x1b[1;3;4mall\x1b[22;23;24m',
  unknown: '\x1b[999mplain \x1b[5mblink',
  onlyEscape: '\x1b[31m',
  reset: '\x1b[31mred\x1b[0m default \x1b[32mgreen',
  multiline: '\x1b[1mfirst\nsecond\x1b[22m\nthird',
  link: 'see \x1b]8;;https://example.com\x07the link\x1b]8;;\x07 here',
  wrap: 'a long line of ordinary words that has to wrap around in a narrow box of cells',
  cjk: '\x1b[38;2;9;9;9m한국어 日本語 emoji 😀\x1b[39m',
};
for (const [name, text] of Object.entries(ANSI)) {
  frame(`ansi-${name}`, 'AnsiText', 60, { children: text });
  frame(`ansi-${name}-default`, 'AnsiText', 60, { children: text, defaultColor: 'rgb(4,5,6)' });
}
for (const theme of THEMES) {
  frame(`ansi-named-${theme}`, 'AnsiText', 60, { children: ANSI.named }, { theme });
  frame(`ansi-bright-${theme}`, 'AnsiText', 60, { children: ANSI.bright }, { theme });
  frame(`ansi-indexed16-${theme}`, 'AnsiText', 60, { children: ANSI.indexed16 }, { theme });
}
frame('ansi-wrap-narrow', 'AnsiText', 20, { children: ANSI.wrap });

// ---- Markdown and streaming markdown -------------------------------------------------------------------------------
for (const [name, text] of Object.entries(MD)) {
  for (const width of WIDTHS) {
    frame(`markdown-${name}-w${width}`, 'Markdown', width, { children: text, columns: width });
  }
  frame(`markdown-${name}-nocolumns`, 'Markdown', 60, { children: text });
  frame(`markdown-${name}-trim`, 'Markdown', 60, { children: text, columns: 60, trimPartialFences: true });
}
for (const theme of THEMES) {
  frame(`markdown-headings-${theme}`, 'Markdown', 80, { children: MD.headings, columns: 80 }, { theme });
  frame(`markdown-code-${theme}`, 'Markdown', 80, { children: MD.code, columns: 80 }, { theme });
  frame(`markdown-quote-${theme}`, 'Markdown', 80, { children: MD.quote, columns: 80 }, { theme });
  frame(`markdown-table-${theme}`, 'Markdown', 80, { children: MD.tableWide, columns: 80 }, { theme });
}
for (const [name, text] of Object.entries(MD)) {
  frame(`streaming-md-${name}-settled`, 'StreamingMarkdown', 60, { children: text, columns: 57, streamKey: `settled-${name}`, streaming: false });
}
{
  const prefix = '**stable**\n\n```txt\nlive';
  const props = { columns: 37, streamKey: 'component-round' };
  frame('streaming-round-1', 'StreamingMarkdown', 40, { ...props, children: prefix });
  frame('streaming-round-2', 'StreamingMarkdown', 40, { ...props, children: `${prefix}\nmore` });
  frame('streaming-round-3', 'StreamingMarkdown', 40, { ...props, children: '**tail**' });
}

// ---- User messages --------------------------------------------------------------------------------------------------
const USER = {
  short: 'hello',
  long: 'A longer prompt that has to wrap around the band of the user message more than once when the terminal is narrow.',
  multiline: 'first line\nsecond line\n\nfourth line after a blank one',
  cjk: '한국어 입력 日本語の入力 with emoji 😀 and mixed 👩‍💻 text that wraps',
  spaces: '  leading and   multiple   spaces  ',
  empty: '',
  skills: 'Use $api-review, not $pptx or `$api-review`; path $HOME, $300.',
  skillsTwice: '$api-review then $pptx and $api-review again',
  skillBoundary: '$pptx_env $pptxUPPER $pptx로 ($pptx) "$pptx"',
};
for (const [name, text] of Object.entries(USER)) {
  for (const width of WIDTHS) {
    frame(`user-${name}-w${width}`, 'UserMessage', width, { text, columns: width });
  }
  frame(`user-${name}-attached`, 'UserMessage', 40, { text, columns: 40, attached: true });
}
for (const width of WIDTHS) {
  frame(`user-applied-w${width}`, 'UserMessage', width, { text: USER.skills, columns: width, appliedSkills: ['api-review'] });
  frame(`user-applied-twice-w${width}`, 'UserMessage', width, { text: USER.skillsTwice, columns: width, appliedSkills: ['api-review', 'pptx'] });
}
frame('user-applied-boundary', 'UserMessage', 60, { text: USER.skillBoundary, columns: 60, appliedSkills: ['pptx'] });
frame('user-applied-unlisted', 'UserMessage', 40, { text: USER.short, columns: 40, appliedSkills: ['unused', '', 3, null] });
frame('user-applied-notarray', 'UserMessage', 40, { text: USER.short, columns: 40, appliedSkills: 'api-review' });
frame('user-notext', 'UserMessage', 40, { columns: 40 });
for (const theme of THEMES) {
  frame(`user-theme-${theme}`, 'UserMessage', 60, { text: USER.skills, columns: 60, appliedSkills: ['api-review'] }, { theme });
}

// ---- Assistant messages ---------------------------------------------------------------------------------------------
for (const [name, text] of Object.entries(MD)) {
  for (const width of WIDTHS) {
    frame(`assistant-${name}-w${width}`, 'AssistantMessage', width, { text, columns: width, assistantId: `a-${name}-${width}` });
  }
}
for (const theme of THEMES) {
  frame(`assistant-theme-${theme}`, 'AssistantMessage', 80, { text: MD.headings, columns: 80, assistantId: `a-theme-${theme}` }, { theme });
}
frame('assistant-narrow', 'AssistantMessage', 10, { text: MD.plain, columns: 10, assistantId: 'a-narrow' });
{
  const text = 'line one\nline two\nline three';
  const props = { text, columns: 40, assistantId: 'window', streamingWindowRows: 2 };
  frame('assistant-window-streaming', 'AssistantMessage', 40, { ...props, streaming: true });
  frame('assistant-window-settled', 'AssistantMessage', 40, { ...props, streaming: false });
  frame('assistant-window-markdown', 'AssistantMessage', 40, { ...props, text: '- a\n- b\n- c\n- d', streaming: true, assistantId: 'window-md' });
  frame('assistant-window-one-row', 'AssistantMessage', 40, { ...props, streamingWindowRows: 1, streaming: true, assistantId: 'window-one' });
}

// Each prefix of five assistant messages as it streams, and the settled message after it. A message keeps its id, so the
// settled prefix of the stream is what the previous frame left.
const STREAMS = {
  plain: 'The quick brown fox jumps over the lazy dog while the streaming text keeps growing word by word until it ends.',
  list: 'Here are the steps:\n\n- first step with `code`\n- second step is **bold**\n- third step\n\nThat is all of them.',
  fence: 'Look at this:\n\n```js\nconst answer = 42;\nconsole.log(answer);\n```\n\nIt prints the number.',
  table: 'A table:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nDone with the table.',
  emphasis: '# Title\n\nSome **bold text that closes later** and *italic words* then `code` and a [link](https://example.com).',
};
for (const [name, text] of Object.entries(STREAMS)) {
  const characters = [...text];
  for (let end = 1; end <= characters.length; end += 3) {
    const prefix = characters.slice(0, end).join('');
    frame(`stream-${name}-${String(end).padStart(3, '0')}`, 'AssistantMessage', 40, { text: prefix, columns: 40, assistantId: `stream-${name}`, streaming: true });
  }
  frame(`stream-${name}-final`, 'AssistantMessage', 40, { text, columns: 40, assistantId: `stream-${name}`, streaming: false });
  frame(`stream-${name}-final-w80`, 'AssistantMessage', 80, { text, columns: 80, assistantId: `stream-${name}-80`, streaming: false });
}

// ---- Notices --------------------------------------------------------------------------------------------------------
for (const tone of ['error', 'warn', 'info', 'plain', 'other', U]) {
  for (const width of WIDTHS) {
    frame(`notice-${tone}-w${width}`, 'NoticeMessage', width, { text: 'A notice that is long enough to wrap around the width of a narrow terminal row.', tone, columns: width });
  }
}
for (const theme of THEMES) {
  frame(`notice-warn-${theme}`, 'NoticeMessage', 60, { text: 'hello', tone: 'warn', columns: 60 }, { theme });
  frame(`notice-error-${theme}`, 'NoticeMessage', 60, { text: 'hello', tone: 'error', columns: 60 }, { theme });
}
frame('notice-cjk', 'NoticeMessage', 30, { text: '한국어 알림 메시지가 길게 이어집니다 日本語', tone: 'info', columns: 30 });
frame('notice-narrow', 'NoticeMessage', 4, { text: 'abcdefgh', tone: 'warn', columns: 4 });

// ---- Completion rows ------------------------------------------------------------------------------------------------
const DONE = [
  [{}, 'default'],
  [{ elapsedMs: 5000 }, 'quick'],
  [{ elapsedMs: 12000 }, 'thought'],
  [{ elapsedMs: 12000, toolCount: 2 }, 'work'],
  [{ toolCount: 2 }, 'work-no-time'],
  [{ status: 'cancelled', elapsedMs: 12000 }, 'cancelled'],
  [{ status: 'cancelled' }, 'cancelled-no-time'],
  [{ elapsedMs: 125000, verb: 'Mapped' }, 'verb'],
  [{ elapsedMs: 12000, verb: '   ' }, 'blank-verb'],
  [{ elapsedMs: 3700000 }, 'hours'],
  [{ elapsedMs: '__NaN__' }, 'nan'],
  [{ elapsedMs: -5 }, 'negative'],
];
for (const [props, name] of DONE) {
  for (const width of WIDTHS) {
    frame(`turndone-${name}-w${width}`, 'TurnDone', width, props);
  }
  frame(`turndone-${name}-hint`, 'TurnDone', 60, { ...props, rightMessage: ' ready\n now ', rightMessageWidth: 12, marginTop: 0 });
}
frame('turndone-hint-long', 'TurnDone', 40, { elapsedMs: 12000, rightMessage: 'a very long hint message that has to be cut', rightTone: 'warn' });
frame('turndone-hint-error', 'TurnDone', 80, { elapsedMs: 12000, rightMessage: 'failed', rightTone: 'error' });
frame('turndone-hint-plain', 'TurnDone', 80, { elapsedMs: 12000, rightMessage: 'plain', rightTone: 'plain', rightMessageWidth: 0 });
frame('turndone-hint-cancel', 'TurnDone', 80, { elapsedMs: 12000, rightMessage: 'cancelled hint', rightTone: 'cancel', rightMessageWidth: 30 });
frame('turndone-hint-wide-cell', 'TurnDone', 20, { elapsedMs: 12000, rightMessage: 'x', rightMessageWidth: 30 });
frame('turndone-hint-narrow-left', 'TurnDone', 24, { elapsedMs: 12000, rightMessage: 'hint', rightMessageWidth: 12 });
frame('turndone-hint-cjk', 'TurnDone', 40, { elapsedMs: 12000, rightMessage: '한국어 힌트 메시지', rightMessageWidth: 10 });
frame('turndone-hint-blank', 'TurnDone', 40, { elapsedMs: 12000, rightMessage: ' \n ' });
for (const theme of THEMES) {
  frame(`turndone-theme-${theme}`, 'TurnDone', 60, { elapsedMs: 12000, rightMessage: 'ready' }, { theme });
}
for (const width of WIDTHS) {
  frame(`statusdone-w${width}`, 'StatusDone', width, { label: 'Done', detail: '2 tasks' });
}
frame('statusdone-default', 'StatusDone', 40, {});
frame('statusdone-blank', 'StatusDone', 40, { label: '  ', detail: '  ' });
frame('statusdone-hint', 'StatusDone', 60, { label: 'Done', detail: '2 tasks', rightMessage: 'next step', rightMessageWidth: 12, marginTop: 0 });
frame('statusdone-hint-nohint', 'StatusDone', 60, { label: 'Done', detail: '2 tasks', rightMessage: '', rightMessageWidth: 12, marginTop: 0 });
frame('statusdone-long', 'StatusDone', 30, { label: 'A very long label that is cut', detail: 'and a long detail too' });

// ---- Queued commands ------------------------------------------------------------------------------------------------
const QUEUE = [
  { id: 'a', text: 'first queued line that wraps around the band when the terminal is narrow' },
  { id: 'b', text: 'second\nwith a line break', displayText: 'shown instead of the text' },
  { id: 'c', text: 'line one\r\nline two that is long enough to be cut in the compact form' },
  { id: 'd', text: '' },
  { id: 'e', text: '한국어 대기 메시지 日本語のキュー emoji 😀 mixed' },
];
for (const width of WIDTHS) {
  frame(`queued-full-w${width}`, 'QueuedCommands', width, { queued: QUEUE, columns: width });
  frame(`queued-compact-w${width}`, 'QueuedCommands', width, { queued: QUEUE, columns: width, compact: true });
}
frame('queued-empty', 'QueuedCommands', 40, { queued: [], columns: 40 });
frame('queued-none', 'QueuedCommands', 40, { columns: 40 });
frame('queued-compact-narrow', 'QueuedCommands', 6, { queued: QUEUE, columns: 6, compact: true });
for (const theme of THEMES) {
  frame(`queued-theme-${theme}`, 'QueuedCommands', 60, { queued: QUEUE.slice(0, 2), columns: 60 }, { theme });
}

// ---- Hook-denial cards ----------------------------------------------------------------------------------------------
const DENIED = {
  hook: { name: 'read', args: { file_path: 'src/a.txt' }, isError: true, result: 'Error: tool "read" denied by hook: nope' },
  notApproved: { name: 'bash', args: { command: 'rm -rf build' }, isError: true, result: 'Error: tool "bash" was not approved: the person said no. Do not retry it or reach the same result another way; report it.' },
  approvalUnavailable: { name: 'write', args: { file_path: 'x.txt', content: 'x' }, isError: true, result: 'Error: tool "write" denied by hook: approval required but no approval UI is available' },
  sanitized: { name: 'read', args: { file_path: '\x1b[31mpath\x1b[0m\x00part\tfile.txt' }, result: 'Error: tool "read" denied\r\nreason\twith\x00controls\x7f' },
  noDetail: { name: 'read', args: { file_path: 'a.txt' }, result: '' },
  noArgs: { name: 'grep', result: 'Error: tool "grep" denied by hook' },
  long: { name: 'read', args: { file_path: 'a/very/long/path/to/some/file/that/does/not/fit/in/the/row.txt' }, result: 'Error: tool "read" denied by hook: a long reason that keeps going past the end of the row for sure' },
  cjk: { name: 'read', args: { file_path: '한국어/파일.txt' }, result: 'Error: tool "read" denied by hook: 한국어 이유가 길게 이어집니다 日本語の理由' },
};
for (const [name, item] of Object.entries(DENIED)) {
  for (const width of WIDTHS) {
    frame(`denied-${name}-w${width}`, 'ToolHookDenialCard', width, { item, columns: width });
  }
}
frame('denied-narrow', 'ToolHookDenialCard', 12, { item: DENIED.hook, columns: 12 });
frame('denied-tiny', 'ToolHookDenialCard', 4, { item: DENIED.hook, columns: 4 });
for (const theme of THEMES) {
  frame(`denied-theme-${theme}`, 'ToolHookDenialCard', 60, { item: DENIED.hook, columns: 60 }, { theme });
}

// ---- The item dispatcher --------------------------------------------------------------------------------------------
const ITEMS = {
  user: { kind: 'user', id: 'u1', text: 'a user prompt that is long enough to wrap around the band in a narrow terminal' },
  userSkills: { kind: 'user', id: 'u2', text: 'Use $api-review please', appliedSkills: ['api-review'] },
  assistant: { kind: 'assistant', id: 'as1', text: '# Answer\n\nSome **bold** text and a list:\n\n- one\n- two', streaming: false },
  assistantStreaming: { kind: 'assistant', id: 'as2', text: 'streaming plain text that is not finished yet', streaming: true },
  notice: { kind: 'notice', id: 'n1', text: 'a notice', tone: 'warn' },
  noticeError: { kind: 'notice', id: 'n2', text: 'an error notice', tone: 'error' },
  turndone: { kind: 'turndone', id: 't1', elapsedMs: 12000, status: 'done', toolCount: 0, verb: 'Mapped' },
  turndoneCancelled: { kind: 'turndone', id: 't2', elapsedMs: 3000, status: 'cancelled' },
  statusdone: { kind: 'statusdone', id: 's1', label: 'Done', detail: '2 tasks' },
  denied: { kind: 'tool', id: 'd1', ...DENIED.hook },
  suppressed: { kind: 'tool', id: 'x1', name: 'read', args: { file_path: 'x' }, isError: true, result: '' },
  unknown: { kind: 'mystery', id: 'm1', text: 'x' },
  nokind: { id: 'k1', text: 'x' },
};
for (const [name, item] of Object.entries(ITEMS)) {
  for (const width of WIDTHS) {
    frame(`item-${name}-w${width}`, 'Item', width, { item, prevKind: 'assistant', columns: width });
  }
  frame(`item-${name}-hint`, 'Item', 60, { item, prevKind: 'assistant', columns: 60, rightMessage: ' hint\n here ', rightTone: 'warn', rightMessageWidth: 14 });
  frame(`item-${name}-hint-default-width`, 'Item', 80, { item, prevKind: 'user', columns: 80, rightMessage: 'default width hint' });
}
for (const prevKind of ['user', 'assistant', 'notice', 'turndone', 'tool', U]) {
  frame(`item-user-prev-${prevKind}`, 'Item', 40, { item: ITEMS.user, prevKind, columns: 40 });
}
frame('item-assistant-window', 'Item', 40, { item: { kind: 'assistant', id: 'win', text: 'one\ntwo\nthree\nfour', streaming: true }, prevKind: 'user', columns: 40, streamingWindowRows: 2 });
frame('item-turndone-no-fields', 'Item', 40, { item: { kind: 'turndone' }, columns: 40 });
frame('item-statusdone-no-fields', 'Item', 40, { item: { kind: 'statusdone' }, columns: 40 });
frame('item-turndone-null-fields', 'Item', 40, { item: { kind: 'turndone', elapsedMs: null, status: null, toolCount: null, verb: null }, columns: 40 });
for (const theme of THEMES) {
  frame(`item-theme-${theme}-user`, 'Item', 60, { item: ITEMS.userSkills, prevKind: 'assistant', columns: 60 }, { theme });
  frame(`item-theme-${theme}-assistant`, 'Item', 60, { item: ITEMS.assistant, prevKind: 'user', columns: 60 }, { theme });
  frame(`item-theme-${theme}-turndone`, 'Item', 60, { item: ITEMS.turndone, prevKind: 'assistant', columns: 60 }, { theme });
  frame(`item-theme-${theme}-denied`, 'Item', 60, { item: ITEMS.denied, prevKind: 'assistant', columns: 60 }, { theme });
}

// The rows of the recorded session folds: every distinct user, assistant and completion row.
{
  const seen = new Map();
  for (const file of readdirSync(foldDirectory).filter((name) => /^\d+\.json$/.test(name)).sort()) {
    const walk = (value) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') {
        if (['user', 'assistant', 'turndone', 'notice', 'statusdone'].includes(value.kind) && ('text' in value || 'elapsedMs' in value || 'label' in value)) {
          const row = { kind: value.kind, id: value.id };
          for (const key of ['text', 'streaming', 'tone', 'appliedSkills', 'elapsedMs', 'status', 'toolCount', 'verb', 'label', 'detail']) {
            if (key in value) row[key] = value[key];
          }
          const key = JSON.stringify({ ...row, id: undefined });
          if (!seen.has(key)) seen.set(key, row);
        }
        Object.values(value).forEach(walk);
      }
    };
    walk(JSON.parse(readFileSync(join(foldDirectory, file), 'utf8')));
  }
  let index = 0;
  const rows = [...seen.values()];
  for (const row of rows) {
    const name = `fold-${String(index).padStart(3, '0')}-${row.kind}`;
    for (const width of WIDTHS) {
      frame(`${name}-w${width}`, 'Item', width, { item: row, prevKind: index % 2 ? 'user' : 'assistant', columns: width });
    }
    if (index % 9 === 0) {
      for (const theme of THEMES.slice(1)) frame(`${name}-${theme}`, 'Item', 80, { item: row, prevKind: 'assistant', columns: 80 }, { theme });
    }
    index += 1;
  }
}

// ---- Pure rules -----------------------------------------------------------------------------------------------------
const SKILL_TEXTS = ['Use $api-review, not $pptx or `$api-review`; path $HOME, $300.', '$a $b $a', '', 'no mentions', '한국어 $pptx로 끝', '\u{1f600} $b!', '```\n$b\n```\n$b'];
const SKILL_VALUES = [['api-review'], ['pptx'], ['a', 'b'], ['b'], [], U, 'a', ['', 3, null, 'a']];
SKILL_VALUES.forEach((value, valueIndex) => {
  fn(`skills-line-${valueIndex}`, 'userMessageSkills', 'appliedSkillsLine', [value]);
  SKILL_TEXTS.forEach((text, textIndex) => fn(`skills-segments-${valueIndex}-${textIndex}`, 'userMessageSkills', 'userTextSegments', [text, value]));
});
fn('skills-segments-nulltext', 'userMessageSkills', 'userTextSegments', [null, ['a']]);
fn('skills-segments-undefinedtext', 'userMessageSkills', 'userTextSegments', [U, ['a']]);

const FAILURE_ITEMS = {
  nothing: null,
  noKind: { result: 'x' },
  notTool: { kind: 'user', isError: true, result: 'Error: tool "x" denied by hook' },
  denied: { kind: 'tool', isError: true, result: 'Error: tool "read" denied by hook: nope' },
  deniedCase: { kind: 'tool', isError: true, result: 'ERROR:TOOL  "read"  DENIED BY HOOK' },
  deniedLaterLine: { kind: 'tool', isError: true, result: 'output\nError: tool "x" denied by hook' },
  deniedNotError: { kind: 'tool', result: 'Error: tool "read" denied by hook' },
  deniedWord: { kind: 'tool', isError: true, result: 'Error: tool "x" denied by hooks' },
  deniedMentioned: { kind: 'tool', isError: true, result: 'see denied by hook in the docs' },
  notApproved: { kind: 'tool', isError: true, result: 'Error: tool "bash" was not approved: no. Do not retry it or reach the same result another way; report it.  ' },
  approvalUnavailable: { kind: 'tool', isError: true, result: 'x denied by hook:  approval required but no approval UI is available' },
  rawResult: { kind: 'tool', isError: true, result: 'a', rawResult: 'Error: tool "x" denied by hook' },
  sameRaw: { kind: 'tool', isError: true, result: 'boom', rawResult: 'boom' },
  numberResult: { kind: 'tool', isError: true, result: 5 },
  nullResult: { kind: 'tool', isError: true, result: null },
  failed: { kind: 'tool', isError: true, result: 'boom' },
  failedBlank: { kind: 'tool', isError: true, result: '  ' },
  ok: { kind: 'tool', isError: false, result: 'ok' },
  pending: { kind: 'tool', isError: true },
  batchAll: { kind: 'tool', count: 3, completedCount: 3, errorCount: 3, result: 'x' },
  batchSome: { kind: 'tool', count: 3, completedCount: 3, errorCount: 2, result: 'x' },
  batchRunning: { kind: 'tool', count: 3, completedCount: 2, isError: true },
  batchStrings: { kind: 'tool', count: '2', completedCount: '2', errorCount: 2, result: 'x' },
  batchNaN: { kind: 'tool', count: 'many', isError: true, result: 'x' },
  batchNullError: { kind: 'tool', count: 2, completedCount: 2, errorCount: null, isError: true, result: 'x' },
  batchFloat: { kind: 'tool', count: 3, completedCount: 3, errorCount: 2.9, result: 'x' },
  taskFailed: { kind: 'tool', args: { task_id: 't1', status: 'Failed' }, isError: true, result: 'x' },
  taskCamel: { kind: 'tool', args: { taskId: 't1', status: 'timeout' }, isError: true, result: 'x' },
  taskRunning: { kind: 'tool', args: { task_id: 't1', status: 'running' }, isError: true, result: 'x' },
  statusNoTask: { kind: 'tool', args: { status: 'failed' }, isError: true, result: 'x' },
  argsString: { kind: 'tool', args: '{"task_id":"t1","status":"killed"}', isError: true, result: 'x' },
  argsInput: { kind: 'tool', args: { input: { task_id: 't1', status: 'error' } }, isError: true, result: 'x' },
};
for (const [name, item] of Object.entries(FAILURE_ITEMS)) {
  fn(`failures-text-${name}`, 'transcriptToolFailures', 'toolItemResultText', [item]);
  fn(`failures-denial-${name}`, 'transcriptToolFailures', 'isHookApprovalDenialToolItem', [item]);
  fn(`failures-batch-${name}`, 'transcriptToolFailures', 'isFullyFailedToolBatch', [item]);
  fn(`failures-suppress-${name}`, 'transcriptToolFailures', 'shouldSuppressFullyFailedToolItem', [item]);
}
const DETAILS = {
  hook: 'Error: tool "read" denied by hook: nope',
  notApproved: 'Error: tool "x" was not approved: reason. Do not retry it or reach the same result another way; report it.  ',
  plain: '  plain  ',
  empty: '',
  onlyPrefix: 'Error: tool "x" ',
  lower: 'error: tool "x" denied by hook',
  none: null,
  number: 5,
  multiline: 'Error: tool "x"\n denied by hook\nsecond line',
};
for (const [name, text] of Object.entries(DETAILS)) fn(`failures-detail-${name}`, 'transcriptToolFailures', 'formatHookDenialDetail', [text]);

process.stdout.write(`${JSON.stringify(cases, null, 1)}\n`);
