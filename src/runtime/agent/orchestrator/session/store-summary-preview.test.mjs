import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cleanSessionPreview,
  isSessionPreviewNoise,
  sessionMessageText,
} from '../../../../session-runtime/session-text.mjs';
import { _normalizeSummaryIndex, _sessionSummary } from './store-summary-index.mjs';

// The pre-memo implementation, verbatim: every summary is compared against it.
function referenceCleanPreview(text, max = 240) {
  const value = cleanSessionPreview(text, max);
  return value.length > max
    ? value
        .slice(0, max)
        .replace(/\s+\S*$/, '')
        .trim()
    : value;
}

function referenceProjection(session) {
  let count = 0;
  let preview = '';
  for (const message of session.messages) {
    if (message && (message.role === 'user' || message.role === 'assistant')) count += 1;
    if (!preview && message?.role === 'user') {
      const raw = sessionMessageText(message.content);
      if (!isSessionPreviewNoise(raw)) preview = referenceCleanPreview(raw);
    }
  }
  return { messageCount: count, preview, title: referenceCleanPreview(session.title || '', 100) };
}

const pasted = 'lorem ipsum dolor sit amet '.repeat(8000); // ~216 KB pasted prompt
const firstMessages = [
  '# Session\nCwd: C:\\work\nModel: claude-opus-4-8\nWorkflow: default\n\nFix the flaky login test please',
  '<system-reminder>\nrouting hints\n</system-reminder>\nReview [Pasted text #1 +120 lines] and summarize the failures',
  `Reference files:\n${pasted}`,
  [
    { type: 'text', text: '<memory-context>recall</memory-context>' },
    { type: 'image', source: {} },
    { type: 'text', text: `  Explain\tthis   diff [Image #2] ${pasted.slice(0, 5000)}` },
  ],
  `<system-reminder>unterminated reminder that lost its closing tag ${pasted.slice(0, 3000)}`,
  '   ',
  `${'가나다라마바사 '.repeat(60)}끝`,
];

function sessionFor(first, index) {
  return {
    id: `sess_preview_${index}`,
    title: index % 2 ? `  Title   with [Pasted text #3] ${'word '.repeat(40)}` : '',
    updatedAt: 1000 + index,
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: '[mixdog-runtime] synthetic control row' },
      { role: 'user', content: first },
      { role: 'assistant', content: 'answer' },
    ],
  };
}

const project = (summary) => ({ messageCount: summary.messageCount, preview: summary.preview, title: summary.title });

test('summary previews and titles equal the unmemoized computation, across saves and growth', () => {
  const sessions = firstMessages.map(sessionFor);
  for (let save = 0; save < 3; save += 1) {
    for (const session of sessions) {
      assert.deepEqual(project(_sessionSummary(session)), referenceProjection(session));
      // Append-only growth between saves, as a live session does.
      session.messages = [...session.messages, { role: 'user', content: `follow-up ${save}` }];
    }
  }
});

test('an in-place scrub of the preview message still changes the preview', () => {
  const session = sessionFor('Original first prompt text', 99);
  assert.equal(_sessionSummary(session).preview, 'Original first prompt text');
  session.messages[2].content = 'Scrubbed replacement prompt';
  assert.equal(_sessionSummary(session).preview, 'Scrubbed replacement prompt');
  const parts = [{ type: 'text', text: 'part prompt' }];
  session.messages[2].content = parts;
  assert.equal(_sessionSummary(session).preview, 'part prompt');
  parts[0].text = 'mutated part prompt';
  assert.equal(_sessionSummary(session).preview, 'mutated part prompt');
  session.messages[2].content = '[mixdog-runtime] now synthetic';
  assert.deepEqual(project(_sessionSummary(session)), referenceProjection(session));
});

test('re-normalizing stored rows is identical to the unmemoized cleaning', () => {
  const rows = firstMessages.map((first, index) => ({
    id: `sess_row_${index}`,
    updatedAt: index,
    title: typeof first === 'string' ? first.slice(0, 300) : 'array title',
    preview: typeof first === 'string' ? first.slice(0, 3000) : ' preview  text ',
  }));
  for (let pass = 0; pass < 3; pass += 1) {
    const normalized = _normalizeSummaryIndex({ rows }).rows;
    for (const row of normalized) {
      const source = rows.find((candidate) => candidate.id === row.id);
      assert.equal(row.title, referenceCleanPreview(source.title || '', 100));
      assert.equal(row.preview, referenceCleanPreview(source.preview || ''));
    }
  }
});
