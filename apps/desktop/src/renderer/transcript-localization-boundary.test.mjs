import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n, { SUPPORTED_UI_LANGUAGES } from './i18n';
import { CompletionStatus } from './transcript-status';
import { localizeErrorCopy } from './error-notice-copy';
import { desktopToolActivityItemPresentation } from './transcript-tool-model';
import { TOOL_RESULT_UI_KEYS } from '../../../../src/runtime/shared/tool-result-summary.mjs';
import { installTestDom } from './test-support/test-dom.mjs';

test('runtime details and errors keep custom words while app-authored status copy translates in every language', async () => {
  const { restore } = installTestDom(null, { globals: { React } });
  try {
    for (const { value: language } of SUPPORTED_UI_LANGUAGES) {
      if (language === 'en') continue;
      const catalog = JSON.parse(readFileSync(new URL(`./locales/${language}.json`, import.meta.url), 'utf8'));
      for (const key of TOOL_RESULT_UI_KEYS) assert.ok(catalog[key]?.trim(), `${language}/${key}`);
      i18n.addResourceBundle(language, 'translation', catalog);
      await i18n.changeLanguage(language);
      for (const text of ['Agent', 'Settings', 'History', 'Rename Agent', '3 tasks']) {
        assert.equal(localizeErrorCopy(text), text, language);
        document.body.innerHTML = renderToStaticMarkup(
          React.createElement(CompletionStatus, {
            item: { kind: 'statusdone', status: 'no_change', label: 'Compact checked', detail: text },
          })
        );
        assert.equal(document.querySelector('span').textContent, catalog['Compact checked'], language);
        assert.equal(document.querySelector('small').textContent, text, language);
        document.body.innerHTML = renderToStaticMarkup(
          React.createElement(CompletionStatus, {
            item: { kind: 'statusdone', status: 'failed', label: text },
          })
        );
        assert.equal(document.querySelector('span').textContent, text, language);
      }
      assert.equal(localizeErrorCopy('Something went wrong.'), catalog['Something went wrong.'], language);
      document.body.innerHTML = renderToStaticMarkup(
        React.createElement(CompletionStatus, {
          item: { kind: 'statusdone', label: 'Compact skipped', detail: 'conversation kept · Agent' },
        })
      );
      assert.equal(
        document.querySelector('small').textContent,
        catalog['Conversation kept · {{reason}}'].replace('{{reason}}', 'Agent'),
        language
      );
    }
  } finally {
    restore();
    await i18n.changeLanguage('en');
  }
});

test('tool output and agent answers cannot be mistaken for UI summaries', async () => {
  try {
    const catalog = JSON.parse(readFileSync(new URL('./locales/ko.json', import.meta.url), 'utf8'));
    i18n.addResourceBundle('ko', 'translation', catalog);
    await i18n.changeLanguage('ko');
    for (const name of ['agent', 'mcp__custom__query', 'shell', 'git']) {
      for (const result of ['Image', '3 files', 'Loaded Agent', 'Settings']) {
        const presentation = desktopToolActivityItemPresentation({
          kind: 'tool',
          name,
          args: {},
          result,
          completedAt: 1,
        });
        assert.equal(presentation.resultLabel, result, `${name}/${result}`);
      }
    }
    const read = desktopToolActivityItemPresentation({
      kind: 'tool',
      name: 'read',
      args: { file_path: 'Agent' },
      result: 'Settings\nHistory',
      completedAt: 1,
    });
    assert.equal(read.resultLabel, catalog['{{count}} lines_other'].replace('{{count}}', '2'));
    assert.equal(read.targetPath, 'Agent');
    const failed = desktopToolActivityItemPresentation({
      kind: 'tool',
      name: 'shell',
      args: {},
      result: 'Image',
      isError: true,
      completedAt: 1,
    });
    assert.equal(failed.resultLabel, 'Image');
    for (const language of ['en', 'ko']) {
      await i18n.changeLanguage(language);
      for (const result of ['[exit code: 0]', '[status: completed]']) {
        const presentation = desktopToolActivityItemPresentation({
          kind: 'tool',
          name: 'shell',
          args: {},
          result,
          completedAt: 1,
        });
        assert.equal(presentation.resultLabel, '', `${language}/${result}`);
      }
    }
  } finally {
    await i18n.changeLanguage('en');
  }
});
