import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n, {
  initUiLanguage,
  getUiLanguagePreference,
  setUiLanguagePreference,
  t,
  tExisting,
  uiFormatLocale,
} from './i18n';
import { SourceControlViewControls } from './SourceControlViewControls';
import { SourceControlCommitForm } from './SourceControlCommitForm';
import { createAppSideViewDescriptors } from './app-side-view-descriptors';
import { desktopSlashCommandDescription, SLASH_COMMANDS } from './slash-commands';
import { partialStagingWarning, resetModePrompt } from './source-control-confirmations';
import { translateNativeUi } from '../shared/native-ui';
import {
  SUPPORTED_UI_LANGUAGES,
  UI_LANGUAGE_STORAGE_KEY,
  uiLanguageForLocale,
  selectUiLanguage,
} from '../shared/ui-language';
import { formatTokenCount, formatWorkElapsed } from './transcript-primitives';
import { goalCompletedTimeLabel } from './session-goal-presentation';
import { uiCurrency } from './ui-format';
import { memoryCacheStorage } from './sw-test-harness.mjs';
import { UI_LANGUAGE_ENTRY, APP_STATE_CACHE_NAME } from './push-notification-bridge';
import { parseMarkdownFrontmatter } from '../../../../src/runtime/shared/markdown-frontmatter.mjs';
import { DEVELOPER_SECTIONS } from '../../../../src/runtime/shared/developer-options.mjs';

const catalogs = new Map(
  SUPPORTED_UI_LANGUAGES.filter(({ value }) => value !== 'en').map(({ value }) => [
    value,
    JSON.parse(readFileSync(new URL(`./locales/${value}.json`, import.meta.url), 'utf8')),
  ])
);
for (const [language, catalog] of catalogs) i18n.addResourceBundle(language, 'translation', catalog);
const noop = () => {};
function browser() {
  return installTestDom(null, {
    html: '<!doctype html><body></body>',
    jsdom: { url: 'https://mixdog.test' },
    expose: ['Node', 'Element', 'HTMLElement', 'MutationObserver', 'navigator'],
    globals: { React },
    actEnvironment: false,
  }).restore;
}

test('all selectable languages render source control and slash labels without a DOM translation pass', async () => {
  const close = browser();
  try {
    for (const [language, catalog] of catalogs) {
      await i18n.changeLanguage(language);
      document.body.innerHTML = renderToStaticMarkup(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(SourceControlViewControls, {
            fileCount: 3,
            fileFilter: '',
            historyQuery: '',
            view: 'changes',
            onFileFilterChange: noop,
            onHistoryQueryChange: noop,
            onViewChange: noop,
          }),
          React.createElement(SourceControlCommitForm, {
            branch: 'feature/Changes',
            busy: '',
            commitBlocked: true,
            conflictCount: 0,
            description: '',
            detached: false,
            fileCount: 3,
            selectedFileCount: 3,
            summary: '',
            onCommit: noop,
            onDescriptionChange: noop,
            onSummaryChange: noop,
          })
        )
      );
      assert.equal(document.querySelectorAll('.dock-scm-tab-label')[1].textContent, catalog.History, language);
      assert.equal(document.querySelector('input[type=search]').placeholder, catalog.Filter, language);
      assert.equal(
        document.querySelector('.dock-scm-commit-summary').placeholder,
        catalog['Summary (required)'],
        language
      );
      const commit = document.querySelector('button[type=submit]');
      const category = new Intl.PluralRules(language).select(3);
      assert.equal(
        commit.textContent,
        catalog[`Commit {{count}} files to {{branch}}_${category}`]
          .replace('{{count}}', '3')
          .replace('{{branch}}', 'feature/Changes'),
        language
      );
      assert.equal(commit.title, catalog['Summary (required)'], language);
      assert.equal(createAppSideViewDescriptors(noop).get('source-control').label, catalog['Source Control'], language);
      assert.equal(createAppSideViewDescriptors(noop).get('session-diff').label, catalog.Changes, language);
      assert.equal(desktopSlashCommandDescription(SLASH_COMMANDS[0]), catalog['Start a fresh chat'], language);
    }
  } finally {
    close();
  }
});

test('a disambiguated key never shows its "Island:" context in any language', () => {
  const locales = ['de', 'es', 'fr', 'it', 'ja', 'ko', 'pt-BR', 'ru', 'vi', 'zh-CN', 'zh-TW'];
  const leaked = [];
  for (const locale of locales) {
    const catalog = JSON.parse(readFileSync(new URL(`./locales/${locale}.json`, import.meta.url), 'utf8'));
    for (const [key, value] of Object.entries(catalog)) {
      if (key.startsWith('Island: ') && /^(Island|島|アイランド|아일랜드)\s*[:：]/.test(value))
        leaked.push(`${locale}: ${key}`);
    }
  }
  assert.deepEqual(leaked, []);
});

test('the bundled workflow description is translated in every supported UI language', async () => {
  const { name, description } = parseMarkdownFrontmatter(
    readFileSync(new URL('../../../../src/workflows/default/WORKFLOW.md', import.meta.url), 'utf8')
  );
  assert.equal(name, 'Default');
  assert.equal(description, 'Handle tasks as requested.');
  const previousLanguage = i18n.language;
  try {
    await i18n.changeLanguage('en');
    assert.equal(t(description), description);
    for (const [language, catalog] of catalogs) {
      await i18n.changeLanguage(language);
      for (const key of [description]) {
        const translated = t(key);
        assert.equal(translated, catalog[key], `${language}: ${key}`);
        assert.ok(translated.trim(), `${language}: ${key} must not be empty`);
        assert.notEqual(translated, key, `${language}: ${key} must be translated`);
      }
    }
    await i18n.changeLanguage('ko');
    assert.equal(t(description), '요청에 맞춰 작업을 진행합니다.');
  } finally {
    await i18n.changeLanguage(previousLanguage);
  }
});

test('every developer option string in the runtime registry is translated in every supported UI language', () => {
  const strings = new Set();
  for (const section of DEVELOPER_SECTIONS) {
    for (const entry of [section, ...section.options]) {
      for (const field of ['label', 'description', 'warning']) if (entry[field]) strings.add(entry[field]);
    }
  }
  assert.ok(strings.has('Show Devin OAuth in Providers and the model picker.'));
  for (const [language, catalog] of catalogs) {
    for (const key of strings) {
      assert.equal(typeof catalog[key], 'string', `${language}: missing developer option text "${key}"`);
      assert.ok(catalog[key].trim(), `${language}: empty developer option text "${key}"`);
    }
  }
});

test('selected language and regional aliases also resolve for native UI', async () => {
  const close = browser();
  try {
    setUiLanguagePreference('ja');
    await initUiLanguage();
    assert.equal(document.documentElement.lang, 'ja');
    assert.equal(t('Sort by Status'), '状態で並べ替え');
    assert.equal(translateNativeUi('ja', 'Browser Use approval'), 'Browser Use の承認');
    assert.equal(uiLanguageForLocale('zh-Hant-HK'), 'zh-TW');
    assert.equal(uiLanguageForLocale('pt-PT'), 'pt-BR');
    assert.equal(translateNativeUi('en', 'Allow this action once?'), 'Allow this action once?');
    setUiLanguagePreference('en');
    await initUiLanguage();
    assert.equal(document.documentElement.lang, 'en');
    assert.equal(t('History'), 'History');
  } finally {
    close();
  }
});

test('destructive-action warnings preserve paths, Git modes, and target identifiers', async () => {
  await i18n.changeLanguage('ko');
  const warning = partialStagingWarning([{ path: 'History/Changes.ts' }]);
  assert.ok(warning.includes('History/Changes.ts'));
  assert.ok(
    warning.includes(t('Committing replaces that staged content with the full working-tree version. Continue?'))
  );
  const reset = resetModePrompt('abc123');
  assert.ok(reset.includes('abc123'));
  for (const token of ['soft', 'mixed', 'hard']) assert.ok(reset.includes(token));
  assert.ok(reset.includes(t('Move HEAD and DISCARD every change made after this commit.')));
});

test('locale selection honors scripts, preference validity and the ordered system languages', () => {
  for (const [locale, expected] of [
    ['zh-Hans-HK', 'zh-CN'],
    ['zh_Hant_CN', 'zh-TW'],
    ['zh-MO', 'zh-TW'],
    ['  pt_PT  ', 'pt-BR'],
    ['de-CH', 'de'],
    ['unsupported', null],
  ])
    assert.equal(uiLanguageForLocale(locale), expected, locale);
  assert.equal(selectUiLanguage('ja', ['ko-KR']), 'ja');
  assert.equal(selectUiLanguage('broken', ['xx-ZZ', 'fr-CA', 'ko']), 'fr');
  assert.equal(selectUiLanguage('system', ['xx']), 'en');
});

test('a failed catalog load resets a previous language and publishes the actual English fallback', async (context) => {
  const close = browser();
  const previousCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  const caches = memoryCacheStorage();
  Object.defineProperty(globalThis, 'caches', { value: caches, configurable: true });
  context.mock.method(console, 'warn', () => {});
  try {
    await i18n.changeLanguage('ko');
    setUiLanguagePreference('de');
    await initUiLanguage(async () => {
      throw new Error('offline catalog');
    });
    assert.equal(t('History'), 'History');
    assert.equal(document.documentElement.lang, 'en');
    assert.equal(uiFormatLocale(), 'en');
    assert.equal(await (await caches.peek(APP_STATE_CACHE_NAME).match(UI_LANGUAGE_ENTRY)).text(), 'en');
    assert.equal(getUiLanguagePreference(), 'de', 'the saved choice survives a transient network failure');
  } finally {
    if (previousCaches) Object.defineProperty(globalThis, 'caches', previousCaches);
    else delete globalThis.caches;
    close();
  }
});

test('blocked preference storage reports failure rather than pretending a reload will retain the choice', () => {
  const close = browser();
  try {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'ja');
    window.Storage.prototype.setItem = () => {
      throw new Error('storage denied');
    };
    assert.equal(setUiLanguagePreference('ko'), false);
    assert.equal(getUiLanguagePreference(), 'ja');
  } finally {
    close();
  }
});

test('all UI languages format tokens, timestamps, durations and currency using the active catalog', async () => {
  const completedAt = Date.parse('2026-09-01T13:42:00Z');
  try {
    for (const { value: language } of SUPPORTED_UI_LANGUAGES) {
      await i18n.changeLanguage(language);
      const tokens = new Intl.NumberFormat(language, { notation: 'compact', maximumFractionDigits: 1 }).format(12_345);
      assert.equal(formatTokenCount(12_345), language === 'en' ? tokens.toUpperCase() : tokens, language);
      assert.equal(
        goalCompletedTimeLabel({ status: 'complete', completedAt }),
        new Date(completedAt).toLocaleTimeString(language, { timeStyle: 'short' }),
        language
      );
      assert.equal(
        formatWorkElapsed(5000),
        new Intl.NumberFormat(language, {
          style: 'unit',
          unit: 'second',
          unitDisplay: 'narrow',
          useGrouping: false,
        }).format(5),
        language
      );
      assert.equal(
        uiCurrency(1234.5, 2),
        new Intl.NumberFormat(language, {
          style: 'currency',
          currency: 'USD',
          currencyDisplay: 'narrowSymbol',
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(1234.5),
        language
      );
    }
  } finally {
    await i18n.changeLanguage('en');
  }
});

test('counted UI text follows locale plural categories while preserving interpolated identifiers', async () => {
  try {
    await i18n.changeLanguage('en');
    assert.equal(t('{{count}} files', { count: 1 }), '1 file');
    assert.equal(t('{{count}} files', { count: 2 }), '2 files');
    assert.equal(tExisting('{{count}} lines', '1 line', { count: 1 }), '1 line');
    for (const [language, catalog] of catalogs) {
      await i18n.changeLanguage(language);
      for (const count of [0, 1, 2, 5, 21, 1.5]) {
        const category = new Intl.PluralRules(language).select(count);
        const key = 'Commit {{count}} files to {{branch}}';
        assert.equal(
          t(key, { count, branch: 'feature/History<&>' }),
          catalog[`${key}_${category}`].replace('{{count}}', String(count)).replace('{{branch}}', 'feature/History<&>'),
          `${language}/${count}`
        );
      }
    }
  } finally {
    await i18n.changeLanguage('en');
  }
});

test('the phone app shell labels approval notification actions in the app’s own language', async () => {
  const close = browser();
  const calls = [];
  window.mixdogNative = {
    platform: 'android',
    version: '1',
    call: async (method, args) => {
      calls.push([method, args]);
      return true;
    },
  };
  try {
    setUiLanguagePreference('ko');
    await initUiLanguage();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      calls.filter(([method]) => method === 'setNotificationLabels'),
      [['setNotificationLabels', { deny: '거절', allowOnce: '한 번만 허용' }]]
    );
  } finally {
    delete window.mixdogNative;
    setUiLanguagePreference('en');
    await initUiLanguage();
    close();
  }
});

test('Korean sent line: a session target takes 에, a bot keeps 에게', async (t) => {
  // The line reads the bot's contact and the session's live state.
  const { installTestDom } = await import('./test-support/test-dom.mjs');
  installTestDom(t, { rootId: false });
  const { AgentHandoffLine } = await import('./agent-task-line');
  const previousLanguage = i18n.language;
  await i18n.changeLanguage('ko');
  try {
    const line = (handoff) =>
      renderToStaticMarkup(
        React.createElement(AgentHandoffLine, { handoff: { name: '', agentId: '', created: false, ...handoff } })
      ).replace(/<[^>]+>/g, '');
    const toSession = line({ sessionId: 'sess_x' });
    assert.match(toSession, /세션에 보냄 · 작업 중/);
    assert.doesNotMatch(toSession, /에게 보냄/);
    assert.match(line({ sessionId: 'sess_home_bot_1', agentId: 'bot_1' }), /bot_1에게 보냄 · 작업 중/);
    assert.match(line({ sessionId: 'sess_y', name: '의존성 업데이트', created: true }), /의존성 업데이트 · 작업 중/);
  } finally {
    await i18n.changeLanguage(previousLanguage);
  }
});
