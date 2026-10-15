import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TranscriptRow } from './transcript-row.tsx';

const markup = (item) => renderToStaticMarkup(React.createElement(TranscriptRow, { item }));

test('a sent message lists its applied skills and marks only those $mentions', () => {
  const html = markup({
    kind: 'user',
    id: 'u1',
    text: '$api-review 기준으로 보고, 결과는 $pptx 한 장으로. 경로는 $HOME/reports, 예산은 $300.',
    appliedSkills: ['api-review', 'pptx'],
  });
  const tokens = [...html.matchAll(/<span class="skill-mention-token">([^<]*)<\/span>/g)].map((match) => match[1]);
  assert.deepEqual(tokens, ['$api-review', '$pptx']);
  assert.ok(html.includes('$HOME/reports'));
  const applied = html.slice(html.indexOf('message-applied-skills'));
  assert.match(applied, /<span>Applied skills<\/span>/);
  const chips = [
    ...applied.matchAll(/class="message-applied-skill" title="([^"]+)">(?:<svg[\s\S]*?<\/svg>)([^<]*)</g),
  ].map((match) => [match[1], match[2]]);
  assert.deepEqual(chips, [
    ['api-review', 'api-review'],
    ['pptx', 'PPT'],
  ]);
});

test('without appliedSkills the row renders plain text and no applied line', () => {
  for (const item of [
    { kind: 'user', id: 'u2', text: '$api-review please' },
    { kind: 'user', id: 'u3', text: '$api-review please', appliedSkills: [] },
    { kind: 'user', id: 'u4', text: '$api-review please', appliedSkills: 'api-review' },
  ]) {
    const html = markup(item);
    assert.ok(!html.includes('skill-mention-token'), html);
    assert.ok(!html.includes('message-applied-skills'), html);
    assert.ok(html.includes('$api-review please'));
  }
});
