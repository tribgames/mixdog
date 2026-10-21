// A connected provider whose model list failed says why, in the UI language,
// in Model management instead of an empty 0 / 0 list.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['Node', 'HTMLElement', 'navigator'],
});
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
after(restore);

const { default: i18n } = await import('./i18n');
const { ModelManagementCard, modelManagementProviders } = await import('./settings/model-management-panel.tsx');
i18n.addResourceBundle(
  'ko',
  'translation',
  JSON.parse(readFileSync(new URL('./locales/ko.json', import.meta.url), 'utf8'))
);

const AUTH_FAILED = '프로바이더 인증에 실패했습니다';
const CHECK_KEY = '로그인 상태나 API 키를 확인한 뒤 다시 시도해 주세요.';

const setup = {
  api: [
    {
      id: 'deepseek',
      name: 'DeepSeek API',
      authenticated: true,
      catalogError: {
        message: 'deepseek models 401: This API key has expired.',
        errorKind: { kind: 'auth', code: 'api_key_expired', status: 401, retryAfterMs: null, resetAt: null },
      },
    },
    {
      id: 'xai',
      name: 'xAI API',
      authenticated: true,
      catalogError: {
        message: 'xai models 403: Your team has used all available credits.',
        errorKind: { kind: 'permission', code: 'permission-denied', status: 403, retryAfterMs: null, resetAt: null },
      },
    },
    { id: 'openai', name: 'OpenAI', authenticated: true },
  ],
  oauth: [],
  local: [],
};

function card(providerId) {
  const provider = modelManagementProviders({ providerSetup: setup, models: [] }).find((row) => row.id === providerId);
  return renderToStaticMarkup(
    React.createElement(ModelManagementCard, {
      provider,
      inUse: '',
      refreshing: false,
      onRefresh() {},
      async onSave() {},
      onClose() {},
    })
  );
}

test('Model management explains an empty list in Korean instead of "No matching models"', async () => {
  await i18n.changeLanguage('ko');
  try {
    const providers = modelManagementProviders({ providerSetup: setup, models: [] });
    assert.deepEqual(
      providers.map((row) => [row.id, row.models.length, row.catalogError != null]),
      [
        ['deepseek', 0, true],
        ['xai', 0, true],
        ['openai', 0, false],
      ]
    );
    const auth = card('deepseek');
    assert.ok(auth.includes(AUTH_FAILED), auth);
    assert.ok(auth.includes(CHECK_KEY));
    assert.equal(auth.includes('일치하는 모델이 없습니다'), false);
    const denied = card('xai');
    assert.ok(denied.includes('이 리소스에 대한 접근 권한이 없습니다.'), denied);
    assert.equal(denied.includes('일치하는 모델이 없습니다'), false);
    // A provider that answered with nothing keeps the ordinary empty state.
    assert.ok(card('openai').includes('일치하는 모델이 없습니다'));
  } finally {
    await i18n.changeLanguage('en');
  }
});
