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
    refreshInitialDeferredMcpSurface,
    reconcileDeferredMcpToolCatalog,
} from '../src/session-runtime/tool-catalog.mjs';

function baseSession() {
    return {
        provider: 'legacy',
        tools: [{ name: 'read', description: 'read a file' }, { name: 'grep', description: 'search' }],
        messages: [{ role: 'system', content: 'BASE PROMPT' }],
    };
}

// A freshly-created session: the create-time surface is baked WITHOUT any MCP
// (server still mid-handshake at create). `shell` is a deferred (non-active)
// standalone tool so BP1 carries a manifest block even before MCP arrives.
function createdSession() {
    const session = baseSession();
    applyDeferredToolSurface(session, 'full', [{ name: 'shell', description: 'run a command' }], { provider: 'legacy' });
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
    applyDeferredToolSurface(session, 'full', [{ name: 'shell', description: 'run a command' }, mcpTool], { provider: 'legacy' });
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
    applyDeferredToolSurface(session, 'full', [{ name: 'shell', description: 'run a command' }, mcpTool], { provider: 'legacy' });
    const before = systemContent(session);
    const announcedBefore = [...session.deferredAnnouncedTools];
    // Resume path never sets the per-session fresh flag.
    assert.equal(session.deferredInitialRefreshPending, undefined, 'resumed session carries no fresh flag');
    const route = firstTurnGate(session, [mcpTool, mcpTool2]);
    assert.equal(route, 'late', 'resumed session takes the late-reconcile path, not the initial refresh');
    assert.equal(systemContent(session), before, 'BP1 untouched on resume (no rebuild)');
    assert.deepEqual([...session.deferredAnnouncedTools], announcedBefore, 'announced set unchanged on resume');
});

test('a fresh session (flagged) is refreshed exactly once, then falls to the late path', () => {
    const session = createdSession();
    session.deferredInitialRefreshPending = true;
    assert.equal(firstTurnGate(session, [mcpTool]), 'refreshed', 'fresh session refreshes on its first turn');
    assert.equal(session.deferredInitialRefreshPending, false, 'fresh flag consumed (one-shot)');
    assert.ok(session.deferredAnnouncedTools.includes('mcp__unity__get_scene'), 'first-turn MCP pre-announced');
    assert.equal(firstTurnGate(session, [mcpTool2]), 'late', 'second turn no longer refreshes');
});
