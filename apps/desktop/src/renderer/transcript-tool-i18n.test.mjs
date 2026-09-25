// Tool-card labels follow the ACTIVE UI language: they are resolved when read,
// never frozen at module load, and a composed label is a catalog template.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n, { t } from './i18n';
import { TOOL_DETAIL_LABELS, toolActivityFieldValue } from './transcript-tool-format.ts';
import { CodeDiff } from './transcript-diff.tsx';

i18n.addResourceBundle(
  'ko',
  'translation',
  JSON.parse(readFileSync(new URL('./locales/ko.json', import.meta.url), 'utf8')),
  true,
  false
);

test('tool detail labels resolve in the language active when they are read', async () => {
  try {
    await i18n.changeLanguage('ko');
    assert.equal(TOOL_DETAIL_LABELS.plan, t('Plan'));
    assert.notEqual(TOOL_DETAIL_LABELS.plan, 'Plan');
    assert.equal(TOOL_DETAIL_LABELS.arguments, t('Arguments'));
  } finally {
    await i18n.changeLanguage('en');
  }
});

test('boolean tool arguments read as translated Yes / No', async () => {
  const hadYes = i18n.exists('Yes', { lng: 'ko' });
  const hadNo = i18n.exists('No', { lng: 'ko' });
  try {
    await i18n.changeLanguage('ko');
    if (!hadYes) i18n.addResource('ko', 'translation', 'Yes', '예');
    if (!hadNo) i18n.addResource('ko', 'translation', 'No', '아니요');
    assert.equal(toolActivityFieldValue('dry_run', true), t('Yes'));
    assert.equal(toolActivityFieldValue('dry_run', false), t('No'));
    assert.notEqual(toolActivityFieldValue('dry_run', true), 'Yes');
  } finally {
    if (!hadYes) i18n.removeResource?.('ko', 'translation', 'Yes');
    if (!hadNo) i18n.removeResource?.('ko', 'translation', 'No');
    await i18n.changeLanguage('en');
  }
});

test('the per-file diff copy label is the interpolated catalog template', async () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    '',
  ].join('\n');
  try {
    await i18n.changeLanguage('ko');
    const markup = renderToStaticMarkup(React.createElement(CodeDiff, { patch }));
    const label =
      /class="tool-detail-copy diff-copy"[^>]*aria-label="([^"]*)"|aria-label="([^"]*)"[^>]*class="tool-detail-copy diff-copy"/.exec(
        markup
      );
    const actual = label?.[1] ?? label?.[2];
    assert.ok(actual, markup);
    assert.equal(actual, t('Copy diff for {{value0}}', { value0: 'src/a.ts' }));
    assert.notEqual(actual, 'Copy diff for src/a.ts');
  } finally {
    await i18n.changeLanguage('en');
  }
});
