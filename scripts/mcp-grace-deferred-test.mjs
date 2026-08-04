// Regression tests for turn-time deferred-manifest construction (claude-code
// style). An MCP server that finishes its handshake BETWEEN session-create and
// the user's FIRST send is folded — on the first turn, synchronously, with no
// boot await — into the INITIAL <available-deferred-tools> manifest (BP1) and
// pre-marked announced, so the first-turn tool-catalog reconcile emits NO late
// <system-reminder> for it. A server that connects AFTER the first turn keeps
// the append-only late-reminder path. Unit-style: exercise the tool-catalog
// exports directly (no runtime, no spawn) the way session-turn-api/runtime-core
// wire them.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applyDeferredToolSurface,
    rebuildDeferredToolSurfaceForProvider,
    refreshInitialDeferredMcpSurface,
    reconcileDeferredMcpToolCatalog,
} from '../src/session-runtime/tool-catalog.mjs';

function baseSession(provider = 'anthropic-oauth') {
    return {
        provider,
        tools: [{ name: 'read', description: 'read a file' }, { name: 'grep', description: 'search' }],
        messages: [{ role: 'system', content: 'BASE PROMPT' }],
    };
}

// A freshly-created session: the create-time surface is baked WITHOUT any MCP
// (server still mid-handshake at create). `shell` is a deferred (non-active)
// standalone tool so BP1 carries a manifest block even before MCP arrives.
function createdSession(provider = 'anthropic-oauth') {
    const session = baseSession(provider);
    applyDeferredToolSurface(session, 'full', [{ name: 'shell', description: 'run a command' }], { provider: session.provider });
    return session;
}

function systemContent(session) {
    return session.messages.find((m) => m.role === 'system').content;
}

const mcpTool = { name: 'mcp__unity__get_scene', description: 'Return the active Unity scene graph.' };
const mcpTool2 = { name: 'mcp__unity__run_tests', description: 'Run the Unity test runner.' };

// Mirror the session-turn-api first-turn gate: refresh runs ONCE, only for a
// session flagged fresh (deferredInitialRefreshPending) at create; a resumed
// session (reloaded transcript, flag absent) takes the late-reconcile path and
// its already-baked BP1 is never rebuilt or re-announced.
function firstTurnGate(session, liveMcp) {
    if (session.deferredInitialRefreshPending) {
        session.deferredInitialRefreshPending = false;
        return refreshInitialDeferredMcpSurface(session, liveMcp) ? 'refreshed' : 'refresh-noop';
    }
    return 'late';
}

test('MCP connecting between session-create and first send lands in the INITIAL manifest, not a late reminder', () => {
    const session = createdSession();
    assert.ok(!systemContent(session).includes('mcp__unity__get_scene'), 'MCP absent from create-time BP1');

    // First-turn refresh: the live registry now includes the connected server.
    const changed = refreshInitialDeferredMcpSurface(session, [mcpTool]);
    assert.equal(changed, true, 'first-turn refresh folded the newly-connected MCP tool');

    const sys = systemContent(session);
    assert.ok(sys.includes('<available-deferred-tools>'), 'manifest block present');
    assert.ok(sys.includes('mcp__unity__get_scene'), 'MCP tool in the INITIAL manifest');
    assert.ok(session.deferredAnnouncedTools.includes('mcp__unity__get_scene'), 'MCP tool pre-marked announced');

    let enqueued = null;
    const result = reconcileDeferredMcpToolCatalog(session, [mcpTool], {
        enqueue: (text) => { enqueued = text; return true; },
    });
    assert.equal(result, null, 'no late-tool announcement for a first-turn-folded tool');
    assert.equal(enqueued, null, 'nothing enqueued for a first-turn-folded tool');
});

test('an MCP server connecting AFTER the first turn is still announced via the late reminder', () => {
    const session = createdSession();
    // First turn: no MCP connected yet — nothing to fold.
    assert.equal(refreshInitialDeferredMcpSurface(session, []), false, 'no live MCP => first-turn no-op');
    assert.ok(!(session.deferredAnnouncedTools || []).includes('mcp__unity__get_scene'), 'MCP not pre-announced');

    // A later turn: the server has since connected → late path fires.
    let enqueued = null;
    const result = reconcileDeferredMcpToolCatalog(session, [mcpTool], {
        enqueue: (text) => { enqueued = text; return true; },
    });
    assert.deepEqual(result, ['mcp__unity__get_scene'], 'late tool announced');
    assert.ok(enqueued && enqueued.includes('mcp__unity__get_scene'), 'late reminder enqueued');
    assert.ok(enqueued.includes('connected after this session started'), 'reminder carries the late-tool sentinel');
});

test('recreated session (MCP already connected at create) seeds its manifest, no late re-announce', () => {
    // Recreate/reset path: createCurrentSession folds the live MCP tools into the
    // surface at create time, so a cwd-change recreate seeds its BP1 directly and
    // never needs the first-turn refresh.
    const session = baseSession();
    applyDeferredToolSurface(session, 'full', [{ name: 'shell', description: 'run a command' }, mcpTool], { provider: session.provider });
    assert.ok(systemContent(session).includes('mcp__unity__get_scene'), 'MCP in recreated BP1');
    assert.ok(session.deferredAnnouncedTools.includes('mcp__unity__get_scene'), 'recreated MCP pre-marked announced');

    let enqueued = null;
    const result = reconcileDeferredMcpToolCatalog(session, [mcpTool], {
        enqueue: (text) => { enqueued = text; return true; },
    });
    assert.equal(result, null, 'no late announcement on recreate');
    assert.equal(enqueued, null, 'nothing enqueued on recreate');
});

test('first-turn refresh is idempotent: a re-render with no new MCP is a no-op and keeps ONE manifest block', () => {
    const session = createdSession();
    assert.equal(refreshInitialDeferredMcpSurface(session, [mcpTool]), true, 'first fold applies');
    const once = systemContent(session);
    assert.equal(refreshInitialDeferredMcpSurface(session, [mcpTool]), false, 'no genuinely-new MCP => no-op');
    const twice = systemContent(session);
    assert.equal(once, twice, 'BP1 byte-identical on re-render');
    assert.equal((twice.match(/<available-deferred-tools>/g) || []).length, 1, 'exactly one manifest block (no duplicate)');
});

test('a second newly-connected MCP tool re-renders BP1 in place (both listed, still one block)', () => {
    const session = createdSession();
    refreshInitialDeferredMcpSurface(session, [mcpTool]);
    assert.equal(refreshInitialDeferredMcpSurface(session, [mcpTool, mcpTool2]), true, 're-fold applies the new tool');
    const sys = systemContent(session);
    assert.ok(sys.includes('mcp__unity__get_scene') && sys.includes('mcp__unity__run_tests'), 'both MCP tools listed');
    assert.equal((sys.match(/<available-deferred-tools>/g) || []).length, 1, 'still exactly one block (rebuilt in place)');
    assert.ok(session.deferredAnnouncedTools.includes('mcp__unity__run_tests'), 'the new tool is pre-announced too');
});

test('a resumed session (no fresh flag, prior baked BP1) is NOT refreshed on its next turn', () => {
    // A prior run baked BP1 with the MCP tool; resume reloads that transcript.
    const session = baseSession();
    applyDeferredToolSurface(session, 'full', [{ name: 'shell', description: 'run a command' }, mcpTool], { provider: session.provider });
    const before = systemContent(session);
    const announcedBefore = [...session.deferredAnnouncedTools];
    // Resume path never sets the per-session fresh flag.
    assert.equal(session.deferredInitialRefreshPending, undefined, 'resumed session carries no fresh flag');
    const route = firstTurnGate(session, [mcpTool, mcpTool2]);
    assert.equal(route, 'late', 'resumed session takes the late-reconcile path, not the initial refresh');
    assert.equal(systemContent(session), before, 'BP1 untouched on resume (no rebuild)');
    assert.deepEqual([...session.deferredAnnouncedTools], announcedBefore, 'announced set unchanged on resume');
});

test('fresh-session refresh state is isolated, one-shot, and survives provider switches without leaking', () => {
    const refreshedSession = createdSession();
    const noOpSession = createdSession();
    refreshedSession.deferredInitialRefreshPending = true;
    noOpSession.deferredInitialRefreshPending = true;

    assert.equal(firstTurnGate(refreshedSession, [mcpTool]), 'refreshed', 'fresh session refreshes on its first turn');
    assert.equal(refreshedSession.deferredInitialRefreshPending, false, 'fresh flag consumed (one-shot)');
    assert.equal(noOpSession.deferredInitialRefreshPending, true, 'consuming one session does not consume another');
    assert.ok(refreshedSession.deferredAnnouncedTools.includes('mcp__unity__get_scene'), 'first-turn MCP pre-announced');
    assert.ok(!noOpSession.deferredAnnouncedTools.includes('mcp__unity__get_scene'), 'announced state does not leak between sessions');
    assert.equal(firstTurnGate(refreshedSession, [mcpTool2]), 'late', 'second turn no longer refreshes');

    rebuildDeferredToolSurfaceForProvider(noOpSession, 'xai');
    noOpSession.provider = 'xai';
    const beforeNoOp = systemContent(noOpSession);
    assert.equal(beforeNoOp.includes('<available-deferred-tools>'), false, 'canonical switch removes native manifest state');
    assert.equal(firstTurnGate(noOpSession, []), 'refresh-noop', 'canonical provider consumes an empty one-shot without a manifest refresh');
    assert.equal(noOpSession.deferredInitialRefreshPending, false, 'no-op also consumes the fresh flag');
    assert.equal(systemContent(noOpSession), beforeNoOp, 'canonical no-op leaves the initial manifest byte-identical');

    rebuildDeferredToolSurfaceForProvider(noOpSession, 'anthropic-oauth');
    noOpSession.provider = 'anthropic-oauth';
    assert.equal(firstTurnGate(noOpSession, [mcpTool2]), 'late', 'switching back cannot resurrect first-turn refresh state');
    assert.ok(!noOpSession.deferredAnnouncedTools.includes('mcp__unity__run_tests'), 'post-switch tool remains eligible for the late path');
});

test('legacy canonical snapshot gains a grace-connected MCP tool for the first turn and session lifetime', () => {
    const session = createdSession('legacy');
    session.deferredInitialRefreshPending = true;
    const before = systemContent(session);

    assert.equal(firstTurnGate(session, [mcpTool]), 'refreshed', 'grace fold updates the canonical snapshot');
    assert.ok(session.tools.some((tool) => tool.name === mcpTool.name), 'tool is provider-visible on the first turn');
    assert.ok(session.deferredCallableTools.includes(mcpTool.name), 'tool is callable for the session');
    assert.ok(session.deferredToolCatalog.some((tool) => tool.name === mcpTool.name), 'tool persists in the session catalog');
    assert.equal(systemContent(session), before, 'canonical refresh does not introduce a native manifest');
    assert.equal(systemContent(session).includes('<available-deferred-tools>'), false);

    const toolsOnce = JSON.stringify(session.tools);
    assert.equal(refreshInitialDeferredMcpSurface(session, [mcpTool]), false, 'repeated fold is a no-op');
    assert.equal(JSON.stringify(session.tools), toolsOnce, 'repeated fold leaves the fixed surface byte-identical');
    assert.equal(firstTurnGate(session, [mcpTool]), 'late', 'one-shot gate remains consumed');
});

test('legacy to Anthropic and back preserves grace MCP availability without manifest leakage or duplication', () => {
    const session = createdSession('legacy');
    assert.equal(refreshInitialDeferredMcpSurface(session, [mcpTool]), true);

    rebuildDeferredToolSurfaceForProvider(session, 'anthropic-oauth');
    session.provider = 'anthropic-oauth';
    assert.ok(session.deferredToolCatalog.some((tool) => tool.name === mcpTool.name), 'native switch retains the MCP catalog entry');
    assert.ok(systemContent(session).includes(mcpTool.name), 'native switch advertises the retained deferred tool');
    assert.equal((systemContent(session).match(/<available-deferred-tools>/g) || []).length, 1, 'native switch creates one manifest');

    rebuildDeferredToolSurfaceForProvider(session, 'legacy');
    session.provider = 'legacy';
    assert.ok(session.tools.some((tool) => tool.name === mcpTool.name), 'canonical switch restores the MCP tool to the active surface');
    assert.ok(session.deferredCallableTools.includes(mcpTool.name), 'canonical switch keeps the MCP tool callable');
    assert.equal(systemContent(session).includes('<available-deferred-tools>'), false, 'native manifest does not leak back to canonical');
    assert.deepEqual(session.deferredAnnouncedTools, [], 'native announcement state does not leak back to canonical');

    rebuildDeferredToolSurfaceForProvider(session, 'anthropic-oauth');
    session.provider = 'anthropic-oauth';
    assert.equal((systemContent(session).match(/<available-deferred-tools>/g) || []).length, 1, 'repeat switch still creates only one manifest');
});

test('canonical MCP arriving after the first-turn grace keeps the fixed snapshot and emits no late reminder', () => {
    const session = createdSession('legacy');
    session.deferredInitialRefreshPending = true;
    assert.equal(firstTurnGate(session, []), 'refresh-noop');
    const before = JSON.stringify(session.tools);
    let enqueued = null;

    const result = reconcileDeferredMcpToolCatalog(session, [mcpTool2], {
        enqueue: (text) => { enqueued = text; return true; },
    });
    assert.equal(result, null, 'canonical reconciliation keeps the create/grace snapshot fixed');
    assert.equal(JSON.stringify(session.tools), before, 'post-grace MCP does not churn the canonical surface');
    assert.equal(session.deferredToolCatalog.some((tool) => tool.name === mcpTool2.name), false);
    assert.equal(enqueued, null, 'canonical provider emits no native late reminder');
    assert.equal(systemContent(session).includes('<available-deferred-tools>'), false);
});
