import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeResolveRoute } from '../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import { resolveRouteContextState, resolveRouteEffortState } from './session-lifecycle.mjs';
import { createLifecycleApi } from './lifecycle-api.mjs';
import { inheritanceFit, inheritanceRouteTarget } from './inheritance-fit.mjs';
import { selectionFastCapable } from './route-state.mjs';
import { saveModelSettings } from '../runtime/agent/orchestrator/runtime-core/model-capabilities.mjs';

test('placeholder metadata keeps a saved Fast setting; resolved metadata still clamps it', () => {
  const route = { provider: 'openai-oauth', model: 'gpt-6-astra', effort: 'high', fast: true };
  const baseConfig = { modelSettings: { 'openai-oauth/gpt-6-astra': { effort: 'high', fast: true } } };
  const saved = (meta) =>
    saveModelSettings(null, route, {
      fastCapable: selectionFastCapable(route.provider, meta, route.effort, {}),
      baseConfig,
    }).modelSettings['openai-oauth/gpt-6-astra'].fast;

  // Catalog not loaded yet (stale or cold): unknown must not erase the choice.
  assert.equal(saved({ id: 'gpt-6-astra', provider: 'openai-oauth' }), true);
  // Catalog advertises the priority tier.
  assert.equal(saved({ id: 'gpt-6-astra', provider: 'openai-oauth', serviceTiers: [{ id: 'priority' }] }), true);
  // Catalog loaded and the model has no Fast tier: clamped as before.
  assert.equal(saved({ id: 'gpt-6-astra', provider: 'openai-oauth', serviceTiers: [] }), false);
});

test('cold route metadata preserves persisted effort and enabled Fast mode', () => {
  assert.deepEqual(
    resolveRouteEffortState(
      {
        provider: 'cursor-oauth',
        model: 'kimi-k3',
        effort: 'high',
        fast: true,
      },
      {
        id: 'kimi-k3',
        provider: 'cursor-oauth',
      }
    ),
    {
      effectiveEffort: 'high',
      fastCapable: true,
      metadataResolved: false,
    }
  );
});

test('resolved route metadata remains authoritative for effort and Fast support', () => {
  assert.deepEqual(
    resolveRouteEffortState(
      {
        provider: 'cursor-oauth',
        model: 'kimi-k3',
        effort: 'max',
        fast: true,
      },
      {
        id: 'kimi-k3',
        provider: 'cursor-oauth',
        reasoningLevels: ['high'],
        fastCapable: false,
        fastEfforts: [],
      }
    ),
    {
      effectiveEffort: 'high',
      fastCapable: false,
      metadataResolved: true,
    }
  );
});

test('resolved Cursor parameter variants validate Fast for the selected effort', () => {
  assert.deepEqual(
    resolveRouteEffortState(
      {
        provider: 'cursor-oauth',
        model: 'gpt-5.6-sol',
        effort: 'high',
        fast: true,
        modelParameters: { context: '272k' },
      },
      {
        id: 'gpt-5.6-sol',
        provider: 'cursor-oauth',
        reasoningLevels: ['high', 'max'],
        fastCapable: true,
        fastEfforts: ['high'],
        parameterVariants: [
          { effort: 'high', fast: 'true', context: '272k' },
          { effort: 'max', fast: 'false', context: '272k' },
        ],
      }
    ),
    {
      effectiveEffort: 'high',
      fastCapable: true,
      metadataResolved: true,
    }
  );
});

test('context percentage uses a model default and ten-point steps', () => {
  assert.deepEqual(
    resolveRouteContextState(
      {},
      {
        contextWindow: 200_000,
        maxContextWindow: 1_000_000,
      }
    ),
    {
      contextPercent: 20,
      contextDefaultPercent: 20,
      selectedContextWindow: 200_000,
    }
  );
  assert.deepEqual(
    resolveRouteContextState(
      { contextPercent: 34 },
      {
        contextWindow: 200_000,
        maxContextWindow: 1_000_000,
      }
    ),
    {
      contextPercent: 30,
      contextDefaultPercent: 20,
      selectedContextWindow: 300_000,
    }
  );
  assert.deepEqual(
    resolveRouteContextState(
      { contextPercent: null },
      {
        contextWindow: 200_000,
        maxContextWindow: 1_000_000,
      }
    ),
    {
      contextPercent: 20,
      contextDefaultPercent: 20,
      selectedContextWindow: 200_000,
    }
  );
});

test('a placeholder model meta still resolves the selected window from the catalog', () => {
  // anthropic-oauth/grok-oauth/gemini have no getCachedModelInfo, so a cold
  // route only ever sees `{ id, provider }`. The saved percentage must survive
  // that instead of leaving the session on the model's full window.
  const windowLookup = (provider, model) => {
    if (provider === 'anthropic-oauth' && model === 'claude-opus-5') {
      return { contextWindow: 1_000_000, maxContextWindow: 0 };
    }
    if (provider === 'openai-oauth' && model === 'gpt-5.6-sol') {
      return { contextWindow: 272_000, maxContextWindow: 1_000_000 };
    }
    return null;
  };
  assert.deepEqual(
    resolveRouteContextState(
      {
        provider: 'anthropic-oauth',
        model: 'claude-opus-5',
        contextPercent: 50,
      },
      { id: 'claude-opus-5', provider: 'anthropic-oauth' },
      windowLookup
    ),
    {
      contextPercent: 50,
      contextDefaultPercent: 50,
      selectedContextWindow: 500_000,
    }
  );
  // A window above the default ceiling starts at the ceiling; the whole
  // window stays an explicit choice.
  const opus = { provider: 'anthropic-oauth', model: 'claude-opus-5' };
  const placeholder = { id: 'claude-opus-5', provider: 'anthropic-oauth' };
  assert.deepEqual(resolveRouteContextState(opus, placeholder, windowLookup), {
    contextPercent: 50,
    contextDefaultPercent: 50,
    selectedContextWindow: 500_000,
  });
  assert.deepEqual(resolveRouteContextState({ ...opus, contextPercent: 100 }, placeholder, windowLookup), {
    contextPercent: 100,
    contextDefaultPercent: 50,
    selectedContextWindow: 1_000_000,
  });
  // A cached row that knows both windows keeps the picker's own scale, so a
  // cold placeholder can never rescale a saved percentage downward.
  assert.deepEqual(
    resolveRouteContextState(
      {
        provider: 'openai-oauth',
        model: 'gpt-5.6-sol',
        contextPercent: 30,
      },
      { id: 'gpt-5.6-sol', provider: 'openai-oauth' },
      windowLookup
    ),
    {
      contextPercent: 30,
      contextDefaultPercent: 30,
      selectedContextWindow: 272_000,
    }
  );
  // An uncached model keeps the model-default intent.
  assert.deepEqual(
    resolveRouteContextState(
      {
        provider: 'anthropic-oauth',
        model: 'unknown-model',
        contextPercent: 50,
      },
      { id: 'unknown-model', provider: 'anthropic-oauth' },
      windowLookup
    ),
    {
      contextPercent: undefined,
      contextDefaultPercent: undefined,
      selectedContextWindow: undefined,
    }
  );
});

test('route config treats a cleared context percentage as model-default intent', () => {
  const resolveRoute = makeResolveRoute(() => 'cursor-oauth');
  assert.equal(
    resolveRoute(
      {
        modelSettings: {
          'cursor-oauth/gpt-5.4': { contextPercent: null },
        },
      },
      {
        provider: 'cursor-oauth',
        model: 'gpt-5.4',
      }
    ).contextPercent,
    undefined
  );
});

// Sized to overflow a 20,000-token heir with room to spare, so the cases below
// exercise refusal and compaction rather than sitting on the trigger.
const CONVERSATION = [
  { role: 'system', content: 'source instructions' },
  { role: 'user', content: 'carry this conversation '.repeat(6_000) },
  { role: 'assistant', content: 'understood '.repeat(200) },
];

test('session inheritance is judged on the heir route, never on the source reading', () => {
  const heir = (overrides = {}) => ({
    provider: 'openai-oauth',
    model: 'gpt-6-astra',
    contextWindow: 500_000,
    compactBoundaryTokens: 500_000,
    compaction: { auto: true },
    tools: [],
    ...overrides,
  });
  const roomy = inheritanceFit(CONVERSATION, heir());
  assert.equal(roomy.known, true);
  assert.equal(roomy.fits, true);
  // System blocks belong to the session that built them and are never carried,
  // so they cannot be charged to the heir either.
  assert.equal(roomy.messages, 2);
  assert.ok(roomy.used > 0 && roomy.used < roomy.limit);

  // The identical conversation prices differently per route: an Anthropic heir
  // is billed above the raw estimate, which is exactly why the source session's
  // own gauge cannot answer this question.
  const anthropic = inheritanceFit(
    CONVERSATION,
    heir({
      provider: 'anthropic-oauth',
      model: 'claude-opus-5',
    })
  );
  assert.ok(anthropic.used > roomy.used);

  // A heir that cannot hold the conversation refuses it before any carry.
  const tight = inheritanceFit(
    CONVERSATION,
    heir({
      contextWindow: 10_000,
      compactBoundaryTokens: 10_000,
    })
  );
  assert.equal(tight.fits, false);
  assert.equal(tight.limit, 10_000);

  // An unmeasurable route is not a refusal.
  assert.equal(
    inheritanceFit(CONVERSATION, {
      provider: 'openai-oauth',
      model: 'gpt-6-astra',
    }).known,
    false
  );
});

test('the inheritance preflight is the same verdict the carry itself reaches', async () => {
  const source = {
    id: 'source',
    provider: 'openai-oauth',
    model: 'gpt-6-astra',
    messages: CONVERSATION,
  };
  const run = async (selectedContextWindow, compactConversation = null) => {
    const route = {
      provider: 'anthropic-oauth',
      model: 'claude-opus-5',
      selectedContextWindow,
    };
    // The heir opens on exactly this route, so it resolves the same window the
    // preflight predicts for it.
    const target = { id: 'heir', messages: [], ...inheritanceRouteTarget(route) };
    const api = createLifecycleApi({
      getSession: () => target,
      getRoute: () => route,
      mgr: { getSession: (id) => (id === source.id ? source : null) },
      invalidateContextStatusCache() {},
      saveSession() {},
      ...(compactConversation ? { compactConversation } : {}),
    });
    return { api, target, fit: api.inheritancePreflight(source.id, route) };
  };

  // Oversized for the heir is no longer a dead end: the preflight announces
  // the compaction pass the carry will run, and the compactor is sized for
  // the HEIR's window, not the source's.
  const budgets = [];
  const compacted = await run(20_000, async ({ budgetTokens }) => {
    budgets.push(budgetTokens);
    return { messages: [{ role: 'user', content: 'Compacted for the heir.' }] };
  });
  assert.equal(compacted.fit.known, true);
  assert.equal(compacted.fit.fits, false);
  assert.equal(compacted.fit.limit, 20_000);
  assert.equal(compacted.fit.willCompact, true);
  assert.equal(compacted.fit.reason, '');
  await compacted.api.inheritFrom(source.id);
  assert.equal(budgets.length, 1);
  assert.ok(budgets[0] > 0 && budgets[0] < compacted.fit.used);
  assert.deepEqual(
    compacted.target.messages.map(({ content }) => content),
    ['Compacted for the heir.']
  );

  // A compaction that yields no conversation is a refusal, not a half-carry:
  // the measured sentence names the heir's route and nothing is carried.
  const refused = await run(20_000, async () => ({ messages: [] }));
  assert.equal(refused.fit.fits, false);
  await assert.rejects(
    refused.api.inheritFrom(source.id),
    new RegExp(`${refused.fit.used} tokens.*${refused.fit.limit}`)
  );
  await assert.rejects(refused.api.inheritFrom(source.id), /anthropic-oauth\/claude-opus-5/);
  assert.deepEqual(refused.target.messages, []);

  const accepted = await run(500_000);
  assert.equal(accepted.fit.fits, true);
  assert.equal(accepted.fit.reason, '');
  await accepted.api.inheritFrom(source.id);
  assert.equal(accepted.target.messages.length, accepted.fit.messages);
});

test('compact:true compacts a conversation that already fits; the default carries it as it is', async () => {
  const source = { id: 'source', provider: 'openai-oauth', model: 'gpt-6-astra', messages: CONVERSATION };
  const route = { provider: 'anthropic-oauth', model: 'claude-opus-5', selectedContextWindow: 500_000 };
  const open = (compactConversation) => {
    const target = { id: 'heir', messages: [], ...inheritanceRouteTarget(route) };
    const api = createLifecycleApi({
      getSession: () => target,
      getRoute: () => route,
      mgr: { getSession: (id) => (id === source.id ? source : null) },
      invalidateContextStatusCache() {},
      saveSession() {},
      compactConversation,
    });
    return { api, target };
  };
  assert.equal(open(null).api.inheritancePreflight(source.id, route).fits, true);

  let calls = 0;
  let compactedSession = null;
  const compacting = open(async ({ session }) => {
    calls += 1;
    compactedSession = session;
    return { messages: [{ role: 'user', content: 'Summarized on request.' }] };
  });
  await compacting.api.inheritFrom(source.id, { compact: true });
  assert.equal(calls, 1);
  // A chosen compaction summarizes even a short conversation: the compactor
  // gets a copy whose summary threshold is the floor; the source is untouched.
  assert.equal(compactedSession.compaction.conversationThresholdTokens, 1);
  assert.notEqual(compactedSession, source);
  assert.equal(source.compaction, undefined);
  assert.deepEqual(
    compacting.target.messages.map(({ content }) => content),
    ['Summarized on request.']
  );

  for (const options of [undefined, { compact: false }]) {
    calls = 0;
    const original = open(async () => {
      calls += 1;
      return { messages: [] };
    });
    await original.api.inheritFrom(source.id, options);
    assert.equal(calls, 0);
    assert.equal(original.target.messages.length, original.api.inheritancePreflight(source.id, route).messages);
  }

  // An explicitly requested compaction that fails is a refusal, never a
  // silent full carry — even though the original would have fit.
  const fault = new Error('compactor down');
  const failing = open(async () => {
    throw fault;
  });
  await assert.rejects(failing.api.inheritFrom(source.id, { compact: true }), (error) => {
    assert.match(error.message, /could not be compacted/);
    assert.equal(error.cause, fault);
    return true;
  });
  assert.deepEqual(failing.target.messages, []);
  const empty = open(async () => ({ messages: [] }));
  await assert.rejects(empty.api.inheritFrom(source.id, { compact: true }), /could not be compacted/);
  assert.deepEqual(empty.target.messages, []);
});
