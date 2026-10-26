import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import i18n from './i18n';
import { localizeOAuthFailure } from './oauth-failure-copy';
import { errorSummary } from './ErrorNotice.tsx';
import { pasteErrorText } from './settings/oauth-login-flow.tsx';
import { SUPPORTED_UI_LANGUAGES } from '../shared/ui-language';
import {
  DEVIN_OAUTH_FAILURE_CODES,
  exchangeDevinCode,
} from '../../../../src/runtime/agent/orchestrator/providers/devin-auth.mjs';

const ko = JSON.parse(readFileSync(new URL('./locales/ko.json', import.meta.url), 'utf8'));
const english = (code) => `${code}: some English sentence (127.0.0.1:59653)`;

test('every Devin sign-in failure code has a cause and a remedy in every language', async () => {
  try {
    for (const { value: language } of SUPPORTED_UI_LANGUAGES) {
      if (language !== 'en') {
        const catalog = JSON.parse(readFileSync(new URL(`./locales/${language}.json`, import.meta.url), 'utf8'));
        i18n.addResourceBundle(language, 'translation', catalog);
      }
      await i18n.changeLanguage(language);
      const english_ = new Set();
      for (const code of DEVIN_OAUTH_FAILURE_CODES) {
        const failure = localizeOAuthFailure(english(code));
        assert.ok(failure?.summary && failure.recovery, `${language}: ${code}`);
        assert.notEqual(failure.summary, failure.recovery, `${language}: ${code}`);
        english_.add(failure.summary);
        if (language !== 'en') {
          await i18n.changeLanguage('en');
          const source = localizeOAuthFailure(english(code));
          await i18n.changeLanguage(language);
          assert.notEqual(failure.summary, source.summary, `${language}: ${code} cause is translated`);
          assert.notEqual(failure.recovery, source.recovery, `${language}: ${code} remedy is translated`);
        }
      }
      assert.equal(english_.size, DEVIN_OAUTH_FAILURE_CODES.length, `${language}: causes are distinct`);
    }
  } finally {
    await i18n.changeLanguage('en');
  }
});

test('a request failure and a timeout of the token exchange read in the UI language', async () => {
  i18n.addResourceBundle('ko', 'translation', ko);
  await i18n.changeLanguage('ko');
  try {
    for (const thrown of [new TypeError('fetch failed'), new DOMException('signal timed out', 'TimeoutError')]) {
      const error = await exchangeDevinCode('c', 'v', {
        fetchFn: async () => {
          throw thrown;
        },
      }).catch((caught) => caught);
      assert.equal(
        pasteErrorText(error),
        'Devin이 로그인을 완료하지 못했습니다. 로그인을 다시 시작해 주세요. 계속 실패하면 나중에 다시 시도해 주세요.'
      );
      assert.equal(errorSummary(error), 'Devin이 로그인을 완료하지 못했습니다.');
    }
  } finally {
    await i18n.changeLanguage('en');
  }
});

test('a coded failure is worded by its code, an uncoded one is left alone', async () => {
  i18n.addResourceBundle('ko', 'translation', ko);
  await i18n.changeLanguage('ko');
  try {
    const raw = new Error(
      "Error invoking remote method 'x': Error: DEVIN_OAUTH_CALLBACK_PORT_IN_USE: Callback port 127.0.0.1:59653 is already in use."
    );
    const summary = errorSummary(raw);
    assert.equal(summary, 'Devin 로그인에 필요한 로컬 포트를 다른 프로그램이 사용 중입니다.');
    assert.notEqual(summary, i18n.t('Something went wrong.'));
    assert.match(
      pasteErrorText(new Error(english('DEVIN_OAUTH_STATE_MISMATCH'))),
      /^붙여넣은 주소는 다른 Devin 로그인에 속합니다\. /
    );
    assert.equal(localizeOAuthFailure('DEVIN_OAUTH_UNKNOWN_CODE: x'), null);
    assert.equal(localizeOAuthFailure('[devin-oauth] callback port in use'), null);
  } finally {
    await i18n.changeLanguage('en');
  }
});
