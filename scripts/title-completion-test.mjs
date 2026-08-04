import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TITLE_SYSTEM_PROMPT,
  createTitleCompletion,
  titleSystemPrompt,
} from '../src/runtime/agent/orchestrator/agent-runtime/title-completion.mjs';

test('title completion calls the maintainer provider without an agent session or generic prompt', async () => {
  const controller = new AbortController();
  const providerConfig = {
    'openai-oauth': { enabled: true },
  };
  const calls = {
    initialized: null,
    route: null,
    send: null,
  };
  const complete = createTitleCompletion({
    loadConfig: () => ({ providers: providerConfig }),
    resolveMaintenanceRoute: (args) => {
      calls.route = args;
      return {
        provider: 'openai-oauth',
        model: 'title-model',
        effort: 'low',
        fast: true,
      };
    },
    initProviders: async (...args) => {
      calls.initialized = args;
    },
    getProvider: (name) => {
      assert.equal(name, 'openai-oauth');
      return {
        send: async (...args) => {
          calls.send = args;
          return { content: '  제목 전용 호출  ' };
        },
      };
    },
  });

  const title = await complete('제목으로 정리할 첫 프롬프트', {
    signal: controller.signal,
    locale: 'ko-KR',
  });

  assert.equal(title, '제목 전용 호출');
  assert.equal(calls.route.agent, 'title-agent');
  assert.deepEqual(calls.initialized, [providerConfig, { signal: controller.signal }]);
  assert.deepEqual(calls.send[0], [
    { role: 'system', content: titleSystemPrompt('ko-KR') },
    { role: 'user', content: '제목으로 정리할 첫 프롬프트' },
  ]);
  assert.equal(calls.send[1], 'title-model');
  assert.equal(calls.send[2], undefined);
  assert.deepEqual(calls.send[3], {
    signal: controller.signal,
    effort: 'low',
    fast: true,
    maxOutputTokens: 128,
  });
  assert(!calls.send[0].some((message) =>
    /tool|coding agent|session context|workspace/i.test(message.content)));
  assert.match(calls.send[0][0].content, /System language\/locale: ko-KR/);
  assert.equal(titleSystemPrompt(''), TITLE_SYSTEM_PROMPT);
});
