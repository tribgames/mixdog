import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatVisualizeTime,
  VISUALIZE_COMMENT_KINDS,
  VISUALIZE_ELEMENT_ROLES,
  VISUALIZE_TAG_ROLES,
  visualizeCommentHints,
  visualizeCommentIcon,
  visualizeCommentKind,
  visualizeCommentLabel,
  visualizeCommentPage,
  visualizeElementName,
  visualizeElementNouns,
  visualizeElementRole,
  visualizeEnglish,
} from './visualize-comment-kinds.ts';

const KINDS = ['html', 'document', 'pdf', 'image', 'audio', 'video', 'inline'];

test('every pane kind has an entry; audio takes no comments', () => {
  assert.equal(visualizeCommentKind('audio'), null);
  assert.equal(visualizeCommentKind('toString'), null, 'only own entries');
  assert.equal(visualizeCommentKind('nope'), null);
  const table = Object.fromEntries(
    KINDS.filter((kind) => VISUALIZE_COMMENT_KINDS[kind]).map((kind) => {
      const entry = visualizeCommentKind(kind);
      return [kind, [entry.select.join('+'), entry.anchors.join('+'), entry.crop, entry.icon, entry.media, entry.page]];
    })
  );
  assert.deepEqual(table, {
    html: ['element+region', 'selector+rect', 'page', 'code', false, true],
    document: ['region', 'rect', 'window', 'file-text', false, false],
    pdf: ['region', 'rect', 'window', 'file-text', false, false],
    image: ['region', 'rect', 'image', 'image', false, false],
    video: ['region', 'rect+time', 'video-frame', 'film', true, false],
    inline: ['region', 'rect', 'window', 'shapes', false, false],
  });
  assert.equal(visualizeCommentPage('html'), true, 'only live pages run the page script');
  assert.equal(visualizeCommentPage('inline'), false);
  assert.equal(visualizeCommentPage('audio'), false);
  assert.equal(visualizeCommentIcon('video'), 'film');
  assert.equal(visualizeCommentIcon('audio'), 'file', 'a fallback icon for any kind');
});

test('labels read like the panel shows them, never as selectors', () => {
  const html = { kind: 'html' };
  assert.equal(visualizeCommentLabel({ type: 'element', role: 'button', name: 'Save' }, html), 'Button · Save');
  assert.equal(visualizeCommentLabel({ type: 'element', role: 'item', name: '' }, html), 'List item');
  assert.equal(visualizeCommentLabel({ type: 'region' }, html), 'Region');
  assert.equal(visualizeCommentLabel({ type: 'region', elements: 1 }, html), 'Region · 1 element');
  assert.equal(visualizeCommentLabel({ type: 'region', elements: 2 }, html), 'Region · 2 elements');
  assert.equal(visualizeCommentLabel({ type: 'region' }, { kind: 'pdf' }), 'PDF · Region');
  assert.equal(visualizeCommentLabel({ type: 'region' }, { kind: 'document' }), 'Document · Region');
  assert.equal(visualizeCommentLabel({ type: 'region' }, { kind: 'image' }), 'Image · Region');
  assert.equal(
    visualizeCommentLabel({ type: 'region' }, { kind: 'inline', inline: { kind: 'mermaid', source: 'graph' } }),
    'Mermaid · Region'
  );
  assert.equal(visualizeCommentLabel({ type: 'region', time: 12.4 }, { kind: 'video' }), 'Video 0:12 · Region');

  // The UI language comes from the caller's translate.
  const ko = {
    Button: '버튼',
    Region: '영역',
    'Region · {{n}} elements': '영역 · 요소 {{n}}개',
    'Video {{time}}': '영상 {{time}}',
  };
  const translate = (key, values) => visualizeEnglish(ko[key] ?? key, values);
  assert.equal(
    visualizeCommentLabel({ type: 'element', role: 'button', name: '저장' }, html, translate),
    '버튼 · 저장'
  );
  assert.equal(visualizeCommentLabel({ type: 'region', elements: 2 }, html, translate), '영역 · 요소 2개');
  assert.equal(visualizeCommentLabel({ type: 'region', time: 12 }, { kind: 'video' }, translate), '영상 0:12 · 영역');
});

test('hints come from the kinds shown, each once', () => {
  const ids = (kinds) => visualizeCommentHints(kinds).map((hint) => hint.id);
  assert.deepEqual(ids(['html']), ['click', 'drag', 'parent']);
  assert.deepEqual(ids(['pdf', 'image']), ['drag']);
  assert.deepEqual(ids(['video']), ['drag', 'play', 'seek']);
  assert.deepEqual(ids(['html', 'video', 'audio']), ['click', 'drag', 'parent', 'play', 'seek']);
  assert.deepEqual(visualizeCommentHints(['html'])[2].keys, ['Alt', '↑']);
});

test('element kinds, nouns and times', () => {
  assert.equal(visualizeElementRole('button'), 'button');
  assert.equal(visualizeElementRole('__proto__'), 'box');
  assert.equal(visualizeElementRole(3), 'box');
  for (const role of Object.values(VISUALIZE_TAG_ROLES)) assert.ok(role in VISUALIZE_ELEMENT_ROLES);
  assert.equal(visualizeElementNouns().item, 'List item');
  assert.equal(visualizeElementNouns((key) => `<${key}>`).button, '<Button>');
  assert.equal(visualizeElementName({ role: 'heading', name: 'Title' }), 'Heading · Title');
  assert.equal(formatVisualizeTime(0), '0:00');
  assert.equal(formatVisualizeTime(75.9), '1:15');
  assert.equal(formatVisualizeTime(3725), '1:02:05');
  assert.equal(formatVisualizeTime(Number.NaN), '0:00');
  assert.equal(visualizeEnglish('{{a}} and {{b}}', { a: 1 }), '1 and {{b}}');
});
