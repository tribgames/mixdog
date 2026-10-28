// A clear archive is a copy of the outgoing session under a new id. Its
// generated environment must name ITS scratch directory (the one its shell
// commands use), never the source's, from creation and on resume of an
// archive saved before that. Real create / ask / clear / save / resume /
// request assembly; only the provider response is fake.
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { makeTempDirSync } from '../../../../../../scripts/lib/scoped-temp.mjs';
const root = makeTempDirSync('clear-archive-scratch');
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });
const { createSession, resumeSession } = await import('./session-lifecycle.mjs');
const { askSession } = await import('./ask-session.mjs');
const { clearSessionMessages } = await import('./session-crud.mjs');
const { refreshSessionWorkspaceContext } = await import('./prompt-utils.mjs');
const { buildWorkspacePromptContext } = await import('./session-prompt-composition.mjs');
const { deleteSession, drainSessionStore, evictLiveSession, loadSession, saveSessionAsync } = await import(
  '../store.mjs'
);
const { _withRegisteredProviderForTestAsync } = await import('../../providers/registry.mjs');
const { modelToolSchemaAllowlist } = await import('../../runtime-core/tool-profile.mjs');
const { buildShellSpawnEnv } = await import('../../tools/builtin/bash-tool/spawn-env.mjs');
const { requestPrefixIdentity } = await import('../thinking-binding.mjs');
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const PROVIDER = 'clear-archive-scratch-test';
const sends = [];
const provider = {
  name: PROVIDER,
  contextWindow: 128000,
  async send(messages) {
    sends.push(structuredClone(messages));
    return { content: 'answer', usage: { inputTokens: 10, outputTokens: 5 } };
  },
};

const scratchLines = (messages) =>
  messages
    .filter((m) => m.role === 'system')
    .flatMap((m) => String(m.content).split('\n'))
    .filter((line) => line.startsWith('- Scratch: '));
const shellScratch = (id) => buildShellSpawnEnv(root, {}, id).TEMP;
const lineFor = (id) => `- Scratch: ${shellScratch(id)} `;
const systemTexts = (session) => session.messages.filter((m) => m.role === 'system').map((m) => m.content);

function storedRecord(id) {
  drainSessionStore();
  const dir = join(process.env.MIXDOG_DATA_DIR, 'sessions');
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const record = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    if (record.id === id) return record;
  }
  return null;
}

function storedIds() {
  drainSessionStore();
  const dir = join(process.env.MIXDOG_DATA_DIR, 'sessions');
  return readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')).id);
}

async function withSource(t, run) {
  await _withRegisteredProviderForTestAsync(PROVIDER, provider, async () => {
    const source = createSession({
      provider: PROVIDER,
      model: 'fake-model',
      cwd: root,
      skipSkills: true,
      schemaAllowedTools: modelToolSchemaAllowlist('headless'),
      workflow: { id: 'headless', delegatesAgents: false },
    });
    t.after(() => deleteSession(source.id, { deferSummaryUpdate: true }));
    await askSession(source.id, `question about ${join(root, 'old-path')}`, null, null, null, null, {});
    drainSessionStore();
    await run(source.id);
  });
}

// What the archive must read back as: the source's saved record, with only
// its scratch line renamed.
function renamedScratch(messages, fromId, toId) {
  return messages.map((m) =>
    m.role === 'system' && typeof m.content === 'string'
      ? { ...m, content: m.content.replace(lineFor(fromId), lineFor(toId)) }
      : m
  );
}

async function resumeAndAsk(id) {
  evictLiveSession(id);
  assert.ok(await resumeSession(id, null));
  sends.length = 0;
  await askSession(id, 'back again', null, null, null, null, {});
  return sends[0];
}

for (const mode of ['plain clear', 'archiveAs']) {
  test(`${mode}: the archive names its own scratch directory, everything else stays as saved`, async (t) => {
    await withSource(t, async (sourceId) => {
      const before = structuredClone(loadSession(sourceId).messages);
      assert.equal(scratchLines(before).length, 1);
      assert.ok(scratchLines(before)[0].startsWith(lineFor(sourceId)));
      const known = new Set(storedIds());
      const archiveAs = `sess_archive_${process.pid}_${Date.now()}`;
      await clearSessionMessages(sourceId, mode === 'archiveAs' ? { archiveAs } : {});
      const archiveId = mode === 'archiveAs' ? archiveAs : storedIds().find((id) => !known.has(id));
      assert.ok(archiveId, 'the archive is on disk');
      t.after(() => deleteSession(archiveId, { deferSummaryUpdate: true }));

      const record = storedRecord(archiveId);
      assert.deepEqual(record.messages, renamedScratch(before, sourceId, archiveId));
      assert.equal(record.bp3EnvironmentContext.includes(sourceId), false);
      assert.ok(record.bp3EnvironmentContext.includes(lineFor(archiveId)));

      const first = await resumeAndAsk(archiveId);
      assert.equal(scratchLines(first).length, 1);
      assert.ok(scratchLines(first)[0].startsWith(lineFor(archiveId)), 'the prompt names the shell scratch');
      assert.match(JSON.stringify(first), /old-path/, 'old paths in the conversation stay');
      assert.equal(loadSession(archiveId).pendingCacheBreakIntent, undefined);

      // The source keeps its own scratch directory.
      sends.length = 0;
      await askSession(sourceId, 'source again', null, null, null, null, {});
      assert.equal(scratchLines(sends[0]).length, 1);
      assert.ok(scratchLines(sends[0])[0].startsWith(lineFor(sourceId)));
    });
  });
}

test('a staged workspace change of the source carries the archive id', async (t) => {
  await withSource(t, async (sourceId) => {
    const other = join(root, 'other-folder');
    mkdirSync(other, { recursive: true });
    const source = loadSession(sourceId);
    refreshSessionWorkspaceContext(source, {
      cwd: other,
      environmentContext: buildWorkspacePromptContext(source, other).environmentContext,
    });
    assert.ok(source.workspaceReroot.target.environmentContext.includes(lineFor(sourceId)));
    const archiveAs = `sess_archive_reroot_${process.pid}_${Date.now()}`;
    await clearSessionMessages(sourceId, { archiveAs });
    t.after(() => deleteSession(archiveAs, { deferSummaryUpdate: true }));
    const { workspaceReroot } = storedRecord(archiveAs);
    for (const facts of [workspaceReroot.seen.environmentContext, workspaceReroot.target.environmentContext]) {
      assert.ok(facts.includes(lineFor(archiveAs)));
      assert.equal(facts.includes(sourceId), false);
    }
  });
});

// The archive's prefix changes with the rename, and resume then finds it
// matching: stored thinking (bound to the source's prefix) and the baselines
// measured against it must already be gone in the saved archive.
for (const openRound of [false, true]) {
  test(`the archive drops thinking bound to the source prefix and stale baselines (${openRound ? 'open tool round' : 'final reply'})`, async (t) => {
    await withSource(t, async (sourceId) => {
      const thinking = { type: 'thinking', thinking: 'weighing', signature: `SourceBoundSig${'A'.repeat(64)}` };
      const source = loadSession(sourceId);
      source.messages.push(
        {
          role: 'assistant',
          content: 'Looking.',
          ...(openRound ? { toolCalls: [{ id: 'call-1', name: 'read', arguments: '{}' }] } : {}),
          thinkingBlocks: [thinking],
          providerReplay: {
            provider: 'anthropic',
            items: [thinking, { type: 'text', text: 'Looking.' }].concat(
              openRound ? [{ type: 'tool_use', id: 'call-1', name: 'read' }] : []
            ),
          },
        },
        ...(openRound ? [{ role: 'tool', toolCallId: 'call-1', content: 'result' }] : [])
      );
      source.contextPressureBaselineTokens = 4321;
      source.contextPressureBaselineMessageCount = source.messages.length;
      source.contextUsageSnapshot = { usedTokens: 4321 };
      const known = new Set(storedIds());
      await clearSessionMessages(sourceId, {});
      const archiveId = storedIds().find((id) => !known.has(id));
      assert.ok(archiveId, 'the archive is on disk');
      t.after(() => deleteSession(archiveId, { deferSummaryUpdate: true }));

      const record = storedRecord(archiveId);
      assert.doesNotMatch(JSON.stringify(record.messages), /SourceBoundSig|thinkingBlocks/);
      assert.match(JSON.stringify(record.messages), /Looking\./, 'the turn text stays');
      if (openRound) assert.ok(JSON.stringify(record.messages).includes('call-1'), 'the tool round stays paired');
      assert.equal(record.contextPressureBaselineTokens ?? null, null);
      assert.equal(record.contextUsageSnapshot, undefined);
      assert.equal(record.pendingCacheBreakIntent, undefined);

      const first = await resumeAndAsk(archiveId);
      assert.doesNotMatch(JSON.stringify(first), /SourceBoundSig|thinkingBlocks/);
    });
  });
}

test('resuming an archive saved with the source scratch line corrects it once; a matching session is untouched', async (t) => {
  await withSource(t, async (sourceId) => {
    // The record old code produced: a plain copy under a new id.
    const staleId = `sess_archive_stale_${process.pid}_${Date.now()}`;
    const stale = { ...structuredClone(loadSession(sourceId)), id: staleId, generation: 0 };
    delete stale.codexWireSessionId;
    await saveSessionAsync(stale);
    t.after(() => deleteSession(staleId, { deferSummaryUpdate: true }));
    assert.ok(scratchLines(storedRecord(staleId).messages)[0].startsWith(lineFor(sourceId)));

    const first = await resumeAndAsk(staleId);
    assert.equal(scratchLines(first).length, 1);
    assert.ok(scratchLines(first)[0].startsWith(lineFor(staleId)));
    assert.match(JSON.stringify(first), /old-path/);
    const resumed = loadSession(staleId);
    assert.equal(JSON.stringify(systemTexts(resumed)).includes(sourceId), false);
    assert.equal(resumed.bp3EnvironmentContext.includes(sourceId), false);

    // Already matching: resume leaves the prompt byte-identical, no cache break.
    const own = loadSession(sourceId);
    const prefix = requestPrefixIdentity(own);
    const messages = JSON.stringify(own.messages);
    evictLiveSession(sourceId);
    const again = await resumeSession(sourceId, null);
    assert.equal(requestPrefixIdentity(again), prefix);
    assert.equal(JSON.stringify(again.messages), messages);
    assert.equal(again.pendingCacheBreakIntent, undefined);
  });
});

// Collision: memory / instruction-file lines that also start with `- Scratch:`
// belong to the user, never to the generated environment.
const { useOwnScratchEnvironment } = await import('./session-scratch-environment.mjs');
const { scratchEnvironmentLine } = await import('./session-prompt-composition.mjs');
const SEP = '\n\n---\n\n';
const MEMORY = '# Core Memory\n- Scratch: memory note, keep me';
const INSTRUCTIONS = '# Instruction Files\n- Scratch: instruction note, keep me';

function collisionSession(split, environmentLine) {
  const id = `sess_collide_${split ? 'split' : 'combined'}`;
  const core = ['You are an agent.', INSTRUCTIONS, MEMORY].join(SEP);
  const tail = [`- Cwd: ${root}\n${environmentLine}\n- Shell tools: x`, 'Respond in English.'].join(SEP);
  const messages = split
    ? [
        { role: 'system', content: core, cacheTier: 'tier3' },
        { role: 'system', content: `# Session\n- Cwd: ${root}${SEP}${tail}`, cacheTier: 'env' },
      ]
    : [{ role: 'system', content: [core, `# Session\n- Cwd: ${root}`, tail].join(SEP), cacheTier: 'tier3' }];
  return { id, bp3EnvSplit: split, bp3CoreContext: core, bp3EnvironmentContext: tail, messages };
}

for (const split of [true, false]) {
  const layout = split ? 'split BP3' : 'combined BP3';
  test(`${layout}: a memory or instruction-file Scratch line survives while the generated line is corrected`, () => {
    const own = scratchEnvironmentLine(`sess_collide_${split ? 'split' : 'combined'}`);
    const stale = collisionSession(split, scratchEnvironmentLine('sess_other_source'));
    assert.equal(useOwnScratchEnvironment(stale), true);
    const fixed = collisionSession(split, own);
    assert.deepEqual(stale.messages, fixed.messages);
    assert.equal(stale.bp3EnvironmentContext, fixed.bp3EnvironmentContext);
    const joined = stale.messages.map((m) => m.content).join('\n');
    assert.ok(joined.includes('- Scratch: memory note, keep me'));
    assert.ok(joined.includes('- Scratch: instruction note, keep me'));
    assert.equal(joined.includes('sess_other_source'), false);
  });

  test(`${layout}: a matching session with colliding lines stays byte-identical`, () => {
    const session = collisionSession(split, scratchEnvironmentLine(`sess_collide_${split ? 'split' : 'combined'}`));
    const before = JSON.stringify(session);
    const refs = session.messages.slice();
    assert.equal(useOwnScratchEnvironment(session), false);
    assert.equal(JSON.stringify(session), before);
    session.messages.forEach((m, i) => assert.equal(m, refs[i]));
  });
}
