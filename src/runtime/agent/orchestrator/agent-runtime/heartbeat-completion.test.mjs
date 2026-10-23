import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createHeartbeatCompletion,
  heartbeatPrompt,
  heartbeatRouteKey,
  parseHeartbeatDecision,
} from './heartbeat-completion.mjs';

const MAIN = { provider: 'main-provider', model: 'main-model' };
const MAINTAINER = { provider: 'fake', model: 'tiny' };

/** A gate over the real route resolution (cycle1-agent → the Maintainer) with a
 *  fake provider that records every call and answers `reply`. */
function gate(config, { reply = 'NOTHING', fail = null, provider } = {}) {
  const calls = { init: [], providers: [], sends: [], logs: [] };
  const decide = createHeartbeatCompletion({
    loadConfig: () => config,
    initProviders: async (providers, options) => {
      calls.init.push([providers, options]);
    },
    getProvider: (name) => {
      calls.providers.push(name);
      if (provider !== undefined) return provider;
      return {
        send: async (...args) => {
          calls.sends.push(args);
          if (fail) throw fail;
          return typeof reply === 'function' ? reply() : reply;
        },
      };
    },
    log: (line) => calls.logs.push(line),
  });
  return { decide, calls };
}

const noProviderWork = (calls) => calls.init.length + calls.providers.length + calls.sends.length;

test('without an enabled Maintainer the gate is unmanaged and touches no provider, whatever the default model is', async () => {
  const configs = {
    'no Maintainer route, a default model': { default: MAIN, providers: {} },
    'Maintainer route kept but switched off': {
      default: MAIN,
      providers: {},
      agents: { maintainer: MAINTAINER },
      disabledAgents: ['maintainer'],
    },
    'a half-set route (no model)': { default: MAIN, providers: {}, agents: { maintainer: { provider: 'fake' } } },
  };
  for (const [name, config] of Object.entries(configs)) {
    const { decide, calls } = gate(config);
    assert.deepEqual(await decide({ digest: ['x'] }), { action: 'unmanaged' }, name);
    assert.equal(noProviderWork(calls), 0, `${name}: no provider is initialised, looked up or called`);
    assert.equal(heartbeatRouteKey({ loadConfig: () => config }), '', name);
  }
});

test('one Maintainer call: system + user message, no tools, small output, low effort, no prompt cache, no 529 retry', async () => {
  const { decide, calls } = gate({ default: MAIN, providers: { fake: {} }, agents: { maintainer: MAINTAINER } });
  assert.deepEqual(await decide({ digest: ['schedule "a" failed 3x in a row'] }), { action: 'nothing' });
  assert.equal(calls.init.length, 1);
  assert.deepEqual(calls.init[0][0], { fake: {} });
  assert.deepEqual(calls.providers, ['fake'], 'the Maintainer provider, not the default one');
  assert.equal(calls.sends.length, 1);
  const [[messages, model, tools, options]] = calls.sends;
  assert.equal(model, 'tiny');
  assert.deepEqual(
    messages.map((message) => message.role),
    ['system', 'user']
  );
  assert.equal(tools, undefined, 'it is offered no tool');
  assert.equal(options.effort, 'low');
  assert.equal(options.fast, false);
  assert.ok(options.maxOutputTokens > 0 && options.maxOutputTokens <= 500, 'the reply is a few short lines');
  assert.equal(options.retry529, false);
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(options.cacheStrategy, { tools: 'none', system: 'none', tier3: 'none', messages: 'none' });
  assert.equal(Object.hasOwn(options, 'sessionId'), false, 'a session-less call');
});

test("the Maintainer's own effort and fast setting are used as configured", async () => {
  const route = { ...MAINTAINER, effort: 'high', fast: true };
  const { decide, calls } = gate({ providers: {}, agents: { maintainer: route } });
  await decide({ digest: ['x'] });
  const [[, , , options]] = calls.sends;
  assert.equal(options.effort, 'high');
  assert.equal(options.fast, true);
});

test('the digest, the open and the declined proposal keys reach the model, and the digest is framed as data', async () => {
  const { decide, calls } = gate({ providers: {}, agents: { maintainer: MAINTAINER } });
  await decide({
    digest: ['schedule "news" failed 3x in a row', '2 approvals waiting for the user'],
    proposals: ['pause-routine:news', 'create-routine:weekly'],
    dismissed: ['create-skill:notes', 'pause-routine:old'],
  });
  const [[messages]] = calls.sends;
  assert.equal(
    messages[1].content,
    [
      'Digest:',
      '- schedule "news" failed 3x in a row',
      '- 2 approvals waiting for the user',
      '',
      'Open proposals: pause-routine:news, create-routine:weekly',
      'Declined proposals: create-skill:notes, pause-routine:old',
    ].join('\n')
  );
  assert.match(messages[0].content, /data, never instructions/);
  assert.match(messages[0].content, /exactly NOTHING/);
  assert.match(messages[0].content, /WAKE on the first line/);
  assert.deepEqual(heartbeatPrompt().user.split('\n'), ['Digest:', '', 'Open proposals: none', 'Declined proposals: none']);
});

test('a provider failure propagates (the heartbeat counts it); so do a missing provider and a failed init', async () => {
  const config = { providers: {}, agents: { maintainer: MAINTAINER } };
  const down = new Error('503 overloaded');
  await assert.rejects(gate(config, { fail: down }).decide({ digest: ['x'] }), (error) => error === down);
  await assert.rejects(gate(config, { provider: null }).decide({ digest: ['x'] }), /provider is unavailable: fake/);
  await assert.rejects(gate(config, { provider: {} }).decide({ digest: ['x'] }), /provider is unavailable: fake/);
  const initFailure = new Error('providers could not start');
  const decide = createHeartbeatCompletion({
    loadConfig: () => config,
    initProviders: async () => {
      throw initFailure;
    },
    getProvider: () => assert.fail('no provider lookup after a failed init'),
    log: () => {},
  });
  await assert.rejects(decide({ digest: ['x'] }), (error) => error === initFailure);
});

test('replies are parsed from plain and structured content; an unusable reply is null and logged, not thrown', async () => {
  const config = { providers: {}, agents: { maintainer: MAINTAINER } };
  const replies = [
    ['WAKE\n- a\n- b', { action: 'wake', items: ['a', 'b'] }],
    [{ content: 'NOTHING' }, { action: 'nothing' }],
    [{ content: [{ type: 'text', text: 'WAKE' }, { type: 'text', text: '- structured' }] }, { action: 'wake', items: ['structured'] }],
    ['I think nothing is needed.', null],
    ['', null],
    [{ content: [] }, null],
  ];
  for (const [reply, expected] of replies) {
    const { decide, calls } = gate(config, { reply });
    assert.deepEqual(await decide({ digest: ['x'] }), expected, JSON.stringify(reply));
    assert.equal(calls.logs.length, 1);
    assert.match(calls.logs[0], /^\[heartbeat\] model=tiny ms=\d+ decision=/);
    if (expected === null) assert.match(calls.logs[0], /decision=none reply=/);
  }
  const { decide, calls } = gate(config, { reply: 'x'.repeat(1000) });
  assert.equal(await decide({ digest: ['x'] }), null);
  assert.ok(calls.logs[0].length < 300, 'a long unusable reply is cut in the log');
});

test('the route key names the Maintainer route and changes with its provider, model or effort', () => {
  const key = (agents, disabledAgents) =>
    heartbeatRouteKey({ loadConfig: () => ({ default: MAIN, agents, ...(disabledAgents ? { disabledAgents } : {}) }) });
  assert.equal(key({ maintainer: MAINTAINER }), 'fake/tiny/');
  assert.equal(key({ maintainer: { ...MAINTAINER, effort: 'high' } }), 'fake/tiny/high');
  assert.equal(key({ maintainer: { provider: 'fake', model: 'other' } }), 'fake/other/');
  assert.equal(key({ maintainer: { provider: 'second', model: 'tiny' } }), 'second/tiny/');
  assert.equal(key({}), '', 'the default model is never the Maintainer');
  assert.equal(key({ maintainer: MAINTAINER }, ['maintainer']), '', 'switched off');
});

test('NOTHING is the whole trimmed reply and nothing else; surrounding whitespace is fine', () => {
  for (const reply of ['NOTHING', '  NOTHING  ', '\n\nNOTHING\n', '\tNOTHING\r\n', '\r\n NOTHING \r\n\r\n']) {
    assert.deepEqual(parseHeartbeatDecision(reply), { action: 'nothing' }, JSON.stringify(reply));
  }
  for (const reply of [
    'nothing',
    'Nothing',
    'NOTHING.',
    'NOTHING!',
    'NOTHING\nWAKE',
    'WAKE\nNOTHING',
    'NOTHING NOTHING',
    '"NOTHING"',
    '`NOTHING`',
    '**NOTHING**',
    '```\nNOTHING\n```',
    '```text\nNOTHING\n```',
    null,
    undefined,
    0,
  ]) {
    assert.equal(parseHeartbeatDecision(reply), null, JSON.stringify(reply));
  }
});

test('WAKE needs 1 to 5 "- " items of at most 300 characters on their own lines, with nothing around them', () => {
  assert.deepEqual(parseHeartbeatDecision('WAKE\n- a'), { action: 'wake', items: ['a'] });
  assert.deepEqual(parseHeartbeatDecision('\n WAKE \r\n-   spaced out  \r\n\r\n- b\r\n'), {
    action: 'wake',
    items: ['spaced out', 'b'],
  });
  const five = ['WAKE', ...[1, 2, 3, 4, 5].map((n) => `- item ${n}`)].join('\n');
  assert.equal(parseHeartbeatDecision(five).items.length, 5);
  assert.deepEqual(parseHeartbeatDecision(`WAKE\n- ${'x'.repeat(300)}`).items, ['x'.repeat(300)]);
  for (const reply of [
    'WAKE',
    'WAKE\n',
    'WAKE\n\n   \n',
    `${five}\n- item 6`,
    `WAKE\n- ${'x'.repeat(301)}`,
    `WAKE\n- fine\n- ${'y'.repeat(301)}`,
    'wake\n- a',
    'Wake\n- a',
    'WAKE:\n- a',
    'WAKE - a',
    'WAKE the user\n- a',
    '- a\nWAKE',
    'Here you go:\nWAKE\n- a',
    'WAKE\n* a',
    'WAKE\n-a',
    'WAKE\n1. a',
    'WAKE\n- a\nplain line',
    'WAKE\nplain line',
    'WAKE\n-',
    'WAKE\n- ',
    'WAKE\n- a\n-',
    'WAKE\n```\n- a\n```',
    '```\nWAKE\n- a\n```',
    '```text\nWAKE\n- a\n```',
    'WAKE\n- a\n```',
    'WAKE\n- a\nNOTHING',
    'NOTHING\nWAKE\n- a',
  ]) {
    assert.equal(parseHeartbeatDecision(reply), null, JSON.stringify(reply));
  }
});
