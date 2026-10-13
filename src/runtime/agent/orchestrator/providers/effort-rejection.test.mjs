import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, beforeEach } from 'node:test';
import { AnthropicProvider } from './anthropic.mjs';
import { AnthropicOAuthProvider, _buildRequestBodyForCacheSmoke } from './anthropic-oauth.mjs';
import {
  ANTHROPIC_EFFORT_LEVELS,
  clampEffortOpts,
  detectEffortRejection,
  nearestAcceptedEffort,
  rejectedEffortLevelsSync,
  resetEffortRejectionCache,
  withEffortRejectionFallback,
} from './effort-rejection.mjs';
import { OpenAICompatProvider } from './openai-compat.mjs';

const dir = mkdtempSync(join(tmpdir(), 'effort-rejection-'));
process.env.MIXDOG_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(join(dir, 'effort-rejections.json'), { force: true });
  resetEffortRejectionCache();
});

const reject = (message, extra = {}) => Object.assign(new Error(message), { status: 400, ...extra });
const quiet = () => {
  const original = process.stderr.write;
  const lines = [];
  process.stderr.write = (chunk) => (lines.push(String(chunk)), true);
  return { lines, restore: () => (process.stderr.write = original) };
};

test('detects 400s that name the reasoning effort value', () => {
  for (const error of [
    reject("Invalid value for reasoning.effort: 'xhigh'"),
    reject("reasoning_effort 'max' is not supported by this model"),
    reject("Unsupported value: 'xhigh' is not supported with this model.", { param: 'reasoning.effort' }),
    { status: 400, error: { message: 'Invalid value', param: 'reasoning_effort', code: 'invalid_value' } },
    { httpStatus: 422, message: "Invalid reasoning effort 'ultra'" },
  ]) {
    assert.ok(detectEffortRejection(error), error.message);
  }
});

test('a message naming only the requested level as invalid for reasoning needs that level to match', () => {
  const error = reject('Unsupported value for reasoning: high');
  assert.ok(detectEffortRejection(error, 'high'));
  assert.equal(detectEffortRejection(error, 'low'), null);
  assert.equal(detectEffortRejection(error), null);
});

test('rejections of other reasoning fields are not effort rejections', () => {
  for (const error of [
    reject("Unsupported value: 'detailed' is not supported with reasoning.summary", { param: 'reasoning.summary' }),
    reject("Invalid value for reasoning.summary: 'auto'. Supported values are: 'concise', 'detailed'."),
    reject('Unsupported parameter: reasoning.include is not supported with this model', { param: 'reasoning.include' }),
    reject("Invalid value for 'reasoning.include': 'high'"),
    reject('Unsupported value for reasoning.summary: high', { param: 'reasoning.summary' }),
  ]) {
    assert.equal(detectEffortRejection(error), null, error.message);
    assert.equal(detectEffortRejection(error, 'high'), null, error.message);
  }
});

test('does not treat other errors as effort rejections', () => {
  for (const error of [
    reject('Invalid value for max_tokens: 0'),
    reject('reasoning_content must be passed back to the API'),
    reject('Unsupported parameter: temperature'),
    reject('Invalid API key'),
    reject("Invalid value for reasoning.effort: 'xhigh'", { status: 500 }),
    { status: 429, message: 'rate limited: reasoning effort invalid' },
    new Error("Invalid value for reasoning.effort: 'xhigh'"),
  ]) {
    assert.equal(detectEffortRejection(error), null, error.message);
  }
});

test('parses the allowed levels from the message', () => {
  assert.deepEqual(
    detectEffortRejection(
      reject("Invalid value for reasoning.effort: 'xhigh'. Supported values are: 'low', 'medium', and 'high'.")
    ).allowed,
    ['low', 'medium', 'high']
  );
  assert.deepEqual(
    detectEffortRejection(reject("reasoning_effort 'max' is invalid; it must be one of ['minimal', 'low']")).allowed,
    ['minimal', 'low']
  );
  assert.equal(detectEffortRejection(reject("Invalid value for reasoning.effort: 'xhigh'")).allowed, null);
});

test('picks the nearest lower level, stepping down one when no list is known', () => {
  assert.equal(nearestAcceptedEffort('xhigh', new Set(['xhigh'])), 'high');
  assert.equal(nearestAcceptedEffort('xhigh', new Set(['xhigh', 'high'])), 'medium');
  const allowed = new Set(['none', 'minimal', 'xhigh', 'max', 'ultra']); // allowed: low, medium, high
  assert.equal(nearestAcceptedEffort('xhigh', allowed), 'high');
  assert.equal(nearestAcceptedEffort('none', new Set(['none'])), null);
  // Nothing lower is accepted: the nearest higher allowed level, only with a known list.
  const onlyHigh = new Set(['none', 'minimal', 'low', 'medium', 'xhigh', 'max', 'ultra']);
  assert.equal(nearestAcceptedEffort('minimal', onlyHigh), null);
  assert.equal(nearestAcceptedEffort('minimal', onlyHigh, { allowHigher: true }), 'high');
});

test('retries once at the nearest allowed level and remembers the rejection on disk', async () => {
  const seen = [];
  const capture = quiet();
  let result;
  try {
    result = await withEffortRejectionFallback('custom-x', 'm1', { effort: 'xhigh' }, undefined, async (opts) => {
      seen.push(opts.effort);
      if (opts.effort === 'xhigh') {
        throw reject("Invalid value for reasoning.effort. Supported values are: 'low', 'medium', 'high'.");
      }
      return 'ok';
    });
  } finally {
    capture.restore();
  }
  assert.equal(result, 'ok');
  assert.deepEqual(seen, ['xhigh', 'high']);
  assert.equal(capture.lines.length, 1);
  assert.match(capture.lines[0], /^\[custom-x\] m1 rejected reasoning effort 'xhigh'; retrying once at 'high'\n$/);

  assert.ok(existsSync(join(dir, 'effort-rejections.json')));
  assert.deepEqual(
    JSON.parse(readFileSync(join(dir, 'effort-rejections.json'), 'utf8')).models['custom-x:m1'].rejected,
    ['xhigh']
  );
  resetEffortRejectionCache(); // a restart: only the file remains
  const rejected = rejectedEffortLevelsSync('custom-x', 'M1');
  assert.ok(rejected instanceof Set);
  for (const level of ['xhigh', 'max', 'ultra', 'none', 'minimal']) assert.ok(rejected.has(level), level);
  for (const level of ['low', 'medium', 'high']) assert.ok(!rejected.has(level), level);
  assert.equal(rejectedEffortLevelsSync('custom-x', 'other').size, 0);
});

test('a rejection persisted by another process is seen without a restart', () => {
  const file = join(dir, 'effort-rejections.json');
  assert.equal(rejectedEffortLevelsSync('shared', 'm').size, 0);
  writeFileSync(file, JSON.stringify({ version: 1, models: { 'shared:m': { rejected: ['max'] } } }));
  assert.deepEqual([...rejectedEffortLevelsSync('shared', 'm')], ['max']);
  writeFileSync(file, JSON.stringify({ version: 1, models: { 'shared:m': { rejected: ['max', 'xhigh'] } } }, null, 2));
  assert.deepEqual([...rejectedEffortLevelsSync('shared', 'm')].sort(), ['max', 'xhigh']);
});

test('a rejected level is clamped before the next request without a round trip', async () => {
  const capture = quiet();
  try {
    await withEffortRejectionFallback('p', 'm', { effort: 'max' }, undefined, async (opts) => {
      if (opts.effort === 'max') throw reject("Invalid value for reasoning.effort: 'max'");
    });
  } finally {
    capture.restore();
  }
  resetEffortRejectionCache();
  const seen = [];
  await withEffortRejectionFallback('p', 'm', { effort: 'max', xaiReasoningEffort: 'max' }, undefined, async (opts) => {
    seen.push([opts.effort, opts.xaiReasoningEffort]);
  });
  assert.deepEqual(seen, [['xhigh', 'xhigh']]);
  assert.equal(clampEffortOpts('p', 'm', { effort: 'high' }, undefined).effort, 'high');
  // The config-level effort is clamped too.
  assert.equal(clampEffortOpts('p', 'm', {}, 'max').effort, 'xhigh');
});

test('retries exactly once: the retry is never retried', async () => {
  let calls = 0;
  const capture = quiet();
  try {
    await assert.rejects(
      withEffortRejectionFallback('p', 'm', { effort: 'high' }, undefined, async () => {
        calls += 1;
        throw reject("Invalid value for reasoning.effort: 'high'");
      }),
      /reasoning\.effort/
    );
  } finally {
    capture.restore();
  }
  assert.equal(calls, 2);
  assert.deepEqual([...rejectedEffortLevelsSync('p', 'm')].sort(), ['high', 'medium']);
});

test('never retries after output reached the caller', async () => {
  for (const emit of [
    (opts) => opts.onTextDelta('hi'),
    (opts) => opts.onToolCall({ name: 't' }),
    (opts) => opts.onStreamDelta({}),
  ]) {
    let calls = 0;
    await assert.rejects(
      withEffortRejectionFallback(
        'p',
        'streamed',
        { effort: 'high', onTextDelta() {}, onToolCall() {}, onStreamDelta() {} },
        undefined,
        async (opts) => {
          calls += 1;
          emit(opts);
          throw reject("Invalid value for reasoning.effort: 'high'");
        }
      )
    );
    assert.equal(calls, 1);
  }
  await assert.rejects(
    withEffortRejectionFallback('p', 'flagged', { effort: 'high' }, undefined, async () => {
      throw reject("Invalid value for reasoning.effort: 'high'", { liveTextEmitted: true });
    })
  );
});

test('other errors and an unset effort pass through untouched', async () => {
  let calls = 0;
  await assert.rejects(
    withEffortRejectionFallback('p', 'm2', { effort: 'high' }, undefined, async () => {
      calls += 1;
      throw reject('Invalid value for max_tokens');
    })
  );
  await assert.rejects(
    withEffortRejectionFallback('p', 'm2', {}, undefined, async () => {
      calls += 1;
      throw reject("Invalid value for reasoning.effort: 'x'");
    })
  );
  assert.equal(calls, 2);
  assert.equal(rejectedEffortLevelsSync('p', 'm2').size, 0);
});

const anthropicError = (message, extra = {}) =>
  Object.assign(new Error(`400 ${message}`), {
    status: 400,
    error: { type: 'error', error: { type: 'invalid_request_error', message } },
    ...extra,
  });

test('detects Anthropic invalid_request_error effort rejections', () => {
  for (const error of [
    anthropicError("output_config.effort: Input should be 'low', 'medium', 'high' or 'max'"),
    anthropicError("This model does not support the effort level 'xhigh'."),
    anthropicError("effort 'max' is not supported for this model"),
    // OAuth surfaces only the flattened text of the response body.
    Object.assign(
      new Error(
        `Anthropic OAuth API 400: {"type":"error","error":{"type":"invalid_request_error","message":"output_config.effort: Input should be 'low' or 'high'"}}`
      ),
      { status: 400, httpStatus: 400 }
    ),
  ]) {
    assert.ok(detectEffortRejection(error, 'xhigh'), error.message);
  }
  assert.deepEqual(
    detectEffortRejection(anthropicError("output_config.effort: Input should be 'low', 'medium', 'high' or 'max'"))
      .allowed,
    ['low', 'medium', 'high', 'max']
  );
});

test('Anthropic thinking, budget and effort-configuration rejections are not effort rejections', () => {
  for (const error of [
    anthropicError('thinking.budget_tokens: Input should be greater than or equal to 1024'),
    anthropicError("thinking.type: Input should be 'enabled', 'disabled' or 'adaptive'"),
    anthropicError(
      'thinking.type.enabled is not supported for this model; use output_config.effort high with adaptive thinking'
    ),
    anthropicError('max_tokens: 200000 > 128000, which is the maximum allowed number of output tokens'),
    anthropicError('temperature may only be set to 1 when thinking is enabled'),
    anthropicError('output_config is not supported in mid-conversation messages'),
    anthropicError("mid-conversation effort update 'high' is not supported by this model"),
    anthropicError("Unsupported item type configuration_update with output_config.effort 'high'"),
    anthropicError('messages.2: tool_use ids were found without tool_result blocks'),
    anthropicError("effort 'max' is not supported for this model", { status: 529 }),
  ]) {
    assert.equal(detectEffortRejection(error, 'high'), null, error.message);
  }
});

const anthropicReject = () =>
  anthropicError("output_config.effort: Input should be 'low', 'medium', 'high' or 'max'. Got 'xhigh'.");

test('the anthropic API-key, OAuth and custom anthropic providers retry a rejected effort once', async () => {
  const oauth = Object.create(AnthropicOAuthProvider.prototype);
  const providers = [
    ['anthropic', new AnthropicProvider({ apiKey: 'k' })],
    ['anthropic-oauth', oauth],
    ['custom-claude', new AnthropicProvider({ name: 'custom-claude', apiKey: 'k', baseURL: 'http://localhost:1' })],
  ];
  for (const [name, provider] of providers) {
    const seen = [];
    provider._sendOnce = async (_messages, _model, _tools, opts) => {
      seen.push(opts.effort);
      if (opts.effort === 'xhigh') throw anthropicReject();
      return { content: 'ok' };
    };
    const capture = quiet();
    try {
      assert.deepEqual(await provider.send([], 'claude-x', [], { effort: 'xhigh' }), { content: 'ok' });
    } finally {
      capture.restore();
    }
    assert.deepEqual(seen, ['xhigh', 'high'], name);
    assert.equal(capture.lines.length, 1, name);
    assert.match(
      capture.lines[0],
      new RegExp(`^\\[${name}\\] claude-x rejected reasoning effort 'xhigh'; retrying once at 'high'`)
    );
    // Remembered for this provider only: the next send is clamped before the request.
    assert.ok(rejectedEffortLevelsSync(name, 'claude-x').has('xhigh'), name);
    await provider.send([], 'claude-x', [], { effort: 'xhigh' });
    assert.deepEqual(seen, ['xhigh', 'high', 'high'], name);
  }
  assert.equal(rejectedEffortLevelsSync('other-claude', 'claude-x').size, 0);
});

test('an Anthropic retry that is rejected again is not retried, and sends nothing outside the wire ladder', async () => {
  const provider = new AnthropicProvider({ apiKey: 'k' });
  const seen = [];
  provider._sendOnce = async (_messages, _model, _tools, opts) => {
    seen.push(opts.effort);
    throw anthropicError(`effort '${opts.effort}' is not supported for this model`);
  };
  const capture = quiet();
  try {
    await assert.rejects(provider.send([], 'claude-y', [], { effort: 'medium' }), /effort/);
    await assert.rejects(provider.send([], 'claude-z', [], { effort: 'low' }), /effort/); // nothing lower on the wire
  } finally {
    capture.restore();
  }
  assert.deepEqual(seen, ['medium', 'low', 'low']);
});

test('a re-entrant send inside a wrapped Anthropic send is owned by the outer wrapper', async () => {
  const provider = new AnthropicProvider({ apiKey: 'k' });
  const seen = [];
  provider._sendOnce = async (_messages, model, tools, opts) => {
    seen.push(opts.effort);
    if (model === 'claude-a') return provider.send([], 'claude-b', tools, opts); // e.g. a fallback model
    throw anthropicError("effort 'xhigh' is not supported for this model");
  };
  const capture = quiet();
  try {
    await assert.rejects(provider.send([], 'claude-a', [], { effort: 'xhigh' }), /effort/);
  } finally {
    capture.restore();
  }
  assert.deepEqual(seen, ['xhigh', 'xhigh', 'high', 'high']);
});

test('a clamped effort changes the Anthropic wire value', async () => {
  const capture = quiet();
  try {
    await withEffortRejectionFallback(
      'anthropic-oauth',
      'claude-mythos-5-1',
      { effort: 'max' },
      undefined,
      async (opts) => {
        if (opts.effort === 'max') throw anthropicError("effort 'max' is not supported for this model");
      },
      { levels: ANTHROPIC_EFFORT_LEVELS }
    );
  } finally {
    capture.restore();
  }
  const opts = clampEffortOpts(
    'anthropic-oauth',
    'claude-mythos-5-1',
    { effort: 'max' },
    undefined,
    ANTHROPIC_EFFORT_LEVELS
  );
  const body = _buildRequestBodyForCacheSmoke([{ role: 'user', content: 'Hello.' }], 'claude-mythos-5-1', [], opts);
  assert.deepEqual(body.output_config, { effort: 'xhigh' });
});

test('the OpenAI-compatible provider retries a rejected effort at the nearest level', async () => {
  const provider = new OpenAICompatProvider('custom-effort', { baseURL: 'http://localhost:1/v1', preconnect: false });
  const seen = [];
  provider._sendWithOpts = async (_messages, _model, _tools, opts) => {
    seen.push(opts.effort);
    if (opts.effort === 'xhigh') throw reject("Invalid value for reasoning.effort: 'xhigh'");
    return { content: 'done' };
  };
  const capture = quiet();
  let result;
  try {
    result = await provider.send([], 'model-a', [], { effort: 'xhigh' });
  } finally {
    capture.restore();
  }
  assert.deepEqual(result, { content: 'done' });
  assert.deepEqual(seen, ['xhigh', 'high']);
  await provider.send([], 'model-a', [], { effort: 'xhigh' });
  assert.deepEqual(seen, ['xhigh', 'high', 'high']);
});
