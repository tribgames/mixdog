import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skillSelectionHeader } from '../../../shared/skill-selection.mjs';
import { invalidateSkillsCache, loadSkillResource } from '../context/collect.mjs';
import { latestSkillBodies } from '../context/skill-state.mjs';
import { patchSkillsDisabled } from '../config.mjs';
import { SKILL_TOOL } from '../runtime-core/tool-defs.mjs';
import { applyDeferredToolSurface } from '../runtime-core/tool-catalog.mjs';
import { prepareExplicitSkills } from './explicit-skills.mjs';
import { runFreshContextCompact } from './loop/fresh-context.mjs';
import { viewSkill } from './loop/tool-helpers.mjs';
import { appendSkillUpdateNotices, SKILL_UPDATE_SOURCE } from './skill-update-notice.mjs';
import { isActualUserInstructionMessage } from './compact/messages.mjs';
import { classifySyntheticUserMessage } from './synthetic-user-envelope.mjs';
import { prepareProviderPrefixGuard } from './provider-prefix-guard.mjs';

const tool = (name) => ({
  name,
  description: `${name} tool.`,
  inputSchema: { type: 'object', properties: { action: { type: 'string' } } },
});

async function withSkills(run) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-skill-currency-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  const backupRoot = process.env.MIXDOG_USER_DATA_BACKUP_ROOT;
  process.env.MIXDOG_DATA_DIR = root;
  process.env.MIXDOG_USER_DATA_BACKUP_ROOT = join(root, 'backups');
  const write = (name, body, dependency = null) => {
    const dir = join(root, 'skills', name);
    mkdirSync(dir, { recursive: true });
    const dependencies = dependency ? `dependencies:\n  tools:\n    - type: tool\n      value: ${dependency}\n` : '';
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Skill ${name}.\n${dependencies}---\n${body}\n`
    );
    invalidateSkillsCache(root);
  };
  const remove = (name) => {
    rmSync(join(root, 'skills', name), { recursive: true, force: true });
    invalidateSkillsCache(root);
  };
  try {
    await run({ root, write, remove });
  } finally {
    invalidateSkillsCache(root);
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    if (backupRoot === undefined) delete process.env.MIXDOG_USER_DATA_BACKUP_ROOT;
    else process.env.MIXDOG_USER_DATA_BACKUP_ROOT = backupRoot;
    rmSync(root, { recursive: true, force: true });
  }
}

function newSession(root) {
  const session = {
    id: 'sess_skill_currency',
    provider: 'anthropic-oauth',
    cwd: root,
    toolSpec: 'full',
    tools: [SKILL_TOOL, tool('office'), tool('sheet')],
    messages: [{ role: 'system', content: 'Stable instructions and skill catalog.' }],
    compaction: { auto: false },
  };
  applyDeferredToolSurface(session, 'full');
  session.liveTurnMessages = session.messages;
  return session;
}

async function load(session, name) {
  const prompt = `${skillSelectionHeader(name)}Work with ${name}.`;
  session.messages.push({ role: 'user', content: prompt });
  await prepareExplicitSkills(prompt, session.messages, session);
}

// Later tool work fills the tool-history budget, so the loader groups fall
// outside the execution tail Compact retains.
function work() {
  const out = [];
  for (let index = 0; index < 4; index += 1) {
    const id = `toolu_read_${index}`;
    out.push(
      { role: 'assistant', content: '', toolCalls: [{ id, name: 'read', arguments: { file_path: `f${index}` } }] },
      { role: 'tool', toolCallId: id, content: 'line '.repeat(250) }
    );
  }
  return out;
}

const compact = async (session) =>
  (
    await runFreshContextCompact({
      sessionRef: session,
      messages: session.messages,
      compactBudgetTokens: 10_000,
      compactPolicy: { contextWindow: 20_000 },
      sessionId: session.id,
      activeTurn: true,
    })
  ).messages;

const skillMessages = (messages) =>
  messages.filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('<skill>'));

test('Compact restores an edited skill from its current source, with a loader pair for its current tools', async () => {
  await withSkills(async ({ root, write }) => {
    write('guide', '# Guide v1\nOLD_RULE', 'office');
    const session = newSession(root);
    await load(session, 'guide');
    session.messages.push(...work());
    write('guide', '# Guide v2\nNEW_RULE', 'sheet');

    const result = await compact(session);
    const bodies = skillMessages(result);
    assert.equal(bodies.length, 1, 'one body per skill');
    assert.match(bodies[0].content, /NEW_RULE/);
    assert.doesNotMatch(JSON.stringify(result), /OLD_RULE/);
    const index = result.indexOf(bodies[0]);
    const loaded = result[index - 1];
    assert.equal(loaded.role, 'tool');
    assert.deepEqual(loaded.nativeToolSearch.toolReferences, ['sheet'], 'the current dependency is exposed');
    assert.deepEqual(
      result[index - 2].toolCalls.map((call) => call.id),
      [loaded.toolCallId],
      'the loader call and its result stay paired'
    );
    assert.ok(session.deferredCallableTools.includes('sheet'), 'the current dependency is armed on the surface');
  });
});

test('running a skill\'s eager dependency tool in the window keeps its body; otherwise it becomes a reload line', async () => {
  await withSkills(async ({ root, write }) => {
    write('guide', '# Guide\nRULE', 'grep');
    const session = newSession(root);
    await load(session, 'guide');
    session.messages.push(...work());
    const first = await compact(session);
    assert.equal(skillMessages(first).length, 1);
    const window = (used) => [
      ...first,
      { role: 'assistant', content: 'Next.' },
      ...(used
        ? [
            { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_dep', name: 'grep', arguments: { pattern: 'x' } }] },
            { role: 'tool', toolCallId: 'toolu_dep', content: 'ok' },
          ]
        : []),
      { role: 'user', content: 'More' },
    ];
    const used = await compact({ ...session, messages: window(true) });
    assert.equal(skillMessages(used).length, 1);
    assert.equal(used.some((m) => m.meta?.source === 'compact-skill-reload'), false);
    const idle = await compact({ ...session, messages: window(false) });
    assert.equal(skillMessages(idle).length, 0);
    assert.deepEqual(
      idle.filter((m) => m.meta?.source === 'compact-skill-reload').map((m) => m.meta.skill),
      ['guide']
    );
  });
});

test('Compact keeps an unchanged skill and its loader pair exactly as loaded', async () => {
  await withSkills(async ({ root, write }) => {
    write('guide', '# Guide\nSTEADY_RULE', 'office');
    const session = newSession(root);
    await load(session, 'guide');
    const loaded = session.messages.slice(-3);
    session.messages.push(...work());

    const result = await compact(session);
    const body = skillMessages(result)[0];
    const index = result.indexOf(body);
    assert.equal(body, loaded[2]);
    assert.deepEqual(result[index - 1], loaded[1]);
    assert.deepEqual(result[index - 2].toolCalls, loaded[0].toolCalls);
  });
});

for (const how of ['removed', 'switched off']) {
  test(`Compact does not restore a skill ${how} since it was loaded`, async () => {
    await withSkills(async ({ root, write, remove }) => {
      write('guide', '# Guide\nGONE_RULE', 'office');
      write('keep', '# Keep\nKEPT_RULE');
      const session = newSession(root);
      await load(session, 'guide');
      await load(session, 'keep');
      // A reload reminder an earlier Compact left for a skill gone since.
      session.messages.push({
        role: 'user',
        content: '[mixdog-runtime] Skill "vanished" was active, but its instructions did not fit after Compact.',
        meta: { source: 'compact-skill-reload', synthetic: true, skill: 'vanished' },
      });
      session.messages.push(...work());
      if (how === 'removed') remove('guide');
      else patchSkillsDisabled(['guide']);

      const result = await compact(session);
      assert.deepEqual(
        latestSkillBodies(result).map((entry) => entry.name),
        ['keep']
      );
      assert.doesNotMatch(JSON.stringify(result), /GONE_RULE|Skill \\"guide\\"|Skill \\"vanished\\"/);
      assert.equal(
        result.some((m) => m.nativeToolSearch?.toolReferences?.includes('office')),
        false,
        'no loader pair for its tools'
      );
    });
  });
}

// Every tool result answers a call of an assistant message before it.
function assertPaired(messages) {
  messages.forEach((message, index) => {
    if (message.role !== 'tool') return;
    const owner = messages
      .slice(0, index)
      .findLast((m) => m.role === 'assistant' && m.toolCalls?.some((call) => call.id === message.toolCallId));
    assert.ok(owner, `result ${message.toolCallId} keeps its call`);
  });
}

// The loader group stays inside the execution tail Compact retains.
async function retainedLoad(root, write, dependency) {
  write('guide', '# Guide v1\nOLD_RULE', dependency);
  const session = newSession(root);
  await load(session, 'guide');
  const call = session.messages.at(-3).toolCalls[0];
  session.messages.push({ role: 'assistant', content: 'Working on it.' }, { role: 'user', content: 'Continue.' });
  return { session, call };
}

test('a loader pair kept in the retained tail carries the current dependencies of an edited skill', async () => {
  await withSkills(async ({ root, write }) => {
    const { session, call } = await retainedLoad(root, write, 'office');
    write('guide', '# Guide v2\nNEW_RULE', 'sheet');

    const result = await compact(session);
    const loaders = result.filter((m) => m.role === 'tool' && m.toolCallId === call.id);
    assert.equal(loaders.length, 1, 'the retained pair is kept once, not evicted or duplicated');
    assert.deepEqual(loaders[0].nativeToolSearch.toolReferences, ['sheet']);
    assert.equal(
      result.some((m) => m.nativeToolSearch?.toolReferences?.includes('office')),
      false,
      'no stale tool payload'
    );
    assert.deepEqual(
      skillMessages(result).map((m) => /NEW_RULE/.test(m.content)),
      [true]
    );
    assertPaired(result);
    assert.ok(session.deferredCallableTools.includes('sheet'));
  });
});

test('a loader pair kept in the retained tail stops implying a removed skill is active', async () => {
  await withSkills(async ({ root, write, remove }) => {
    const { session, call } = await retainedLoad(root, write, 'office');
    remove('guide');

    const result = await compact(session);
    const loaders = result.filter((m) => m.role === 'tool' && m.toolCallId === call.id);
    assert.equal(loaders.length, 1);
    assert.equal(loaders[0].nativeToolSearch, undefined);
    assert.match(loaders[0].content, /Skill "guide" is no longer available/);
    assert.equal(
      result.some((m) => m.nativeToolSearch),
      false,
      'no tool payload implies its tools are active'
    );
    assert.deepEqual(skillMessages(result), []);
    assertPaired(result);
  });
});

test('an in-place edit of a deeply nested skill is seen without invalidating the catalog', async () => {
  await withSkills(async ({ root }) => {
    const dir = join(root, 'skills', 'team', 'area', 'topic', 'guide');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'SKILL.md');
    const skillText = (rule) => `---\nname: guide\ndescription: Nested guide.\n---\n# Guide\n${rule}\n`;
    writeFileSync(file, skillText('NESTED_ONE'));
    invalidateSkillsCache(root);
    const session = newSession(root);
    await load(session, 'guide');
    assert.match(latestSkillBodies(session.messages)[0].message.content, /NESTED_ONE/);

    // Edited outside the app: no invalidation, and no watcher turn in between.
    writeFileSync(file, skillText('NESTED_TWO_LONGER'));
    const reload = viewSkill(root, 'guide', session);
    assert.equal(reload.newMessages.length, 1);
    assert.match(reload.newMessages[0].content, /NESTED_TWO_LONGER/);
    const told = appendSkillUpdateNotices(session.messages, root);
    assert.equal(told.length, 1);
    assert.match(told[0].content, /Skill "guide" was updated/);
  });
});

test('a same-size, same-mtime edit of a nested skill is picked up after the skills watcher reports it', async () => {
  await withSkills(async ({ root }) => {
    const dir = join(root, 'skills', 'team', 'area', 'topic', 'guide');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'SKILL.md');
    const skillText = (rule) => `---\nname: guide\ndescription: Nested guide.\n---\n# Guide\n${rule}\n`;
    // A whole-second timestamp restores exactly.
    const stamp = new Date('2024-01-01T00:00:00Z');
    writeFileSync(file, skillText('RULE_AAAA'));
    utimesSync(file, stamp, stamp);
    invalidateSkillsCache(root);
    // The load opens the production watcher on the skills root.
    assert.match(loadSkillResource('guide', root).content, /RULE_AAAA/);
    const before = statSync(file);

    writeFileSync(file, skillText('RULE_BBBB'));
    utimesSync(file, stamp, stamp);
    // Same size and mtime: the file's own stamp cannot tell, and the nested
    // file is below the catalog's signature walk.
    const after = statSync(file);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);

    // The watcher's event (delivered asynchronously) makes the next load re-read.
    const deadline = Date.now() + 10_000;
    let content = '';
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      content = loadSkillResource('guide', root).content;
      if (content.includes('RULE_BBBB')) break;
    }
    assert.match(content, /RULE_BBBB/);
  });
});

const notices = (messages) => messages.filter((m) => m.meta?.source === SKILL_UPDATE_SOURCE);

test('a changed loaded skill is announced once per version, append-only, until it is reloaded', async () => {
  await withSkills(async ({ root, write }) => {
    write('guide', '# Guide v1\nRULE_ONE');
    write('steady', '# Steady\nSTEADY_RULE');
    const session = newSession(root);
    await load(session, 'guide');
    await load(session, 'steady');
    session.messages.push({ role: 'assistant', content: 'Done.' });

    // Unchanged skills: no notice.
    session.messages.push({ role: 'user', content: 'Next.' });
    assert.deepEqual(appendSkillUpdateNotices(session.messages, root), []);

    write('guide', '# Guide v2\nRULE_TWO');
    session.messages.push({ role: 'assistant', content: 'Done.' }, { role: 'user', content: 'Another step.' });
    const before = structuredClone(session.messages);
    const baseline = prepareProviderPrefixGuard(null, session.messages, { tools: [] }, { provider: 'openai-oauth' });
    const first = appendSkillUpdateNotices(session.messages, root);
    assert.equal(first.length, 1, 'exactly one notice');
    assert.equal(first[0].meta.skill, 'guide');
    assert.match(first[0].content, /^\[mixdog-runtime\] Skill "guide" was updated since it was loaded\./);
    assert.equal(first[0].meta.synthetic, true);
    assert.equal(isActualUserInstructionMessage(first[0]), false, 'never read as a human request');
    assert.equal(classifySyntheticUserMessage(first[0]), 'runtime-control');
    assert.deepEqual(session.messages.slice(0, before.length), before, 'earlier messages are byte-identical');
    const breaks = [];
    prepareProviderPrefixGuard(
      baseline,
      session.messages,
      { tools: [] },
      { provider: 'openai-oauth', onCacheBreak: (event) => breaks.push(event) }
    );
    assert.deepEqual(breaks, [], 'the cached prefix stays intact');

    // The next turn while the same change is pending: nothing more.
    session.messages.push({ role: 'assistant', content: 'Noted.' }, { role: 'user', content: 'Go on.' });
    assert.deepEqual(appendSkillUpdateNotices(session.messages, root), []);

    // A Skill reload delivers the new body and ends the notices.
    const reload = viewSkill(root, 'guide', session);
    assert.equal(reload.newMessages.length, 1);
    assert.match(reload.newMessages[0].content, /RULE_TWO/);
    session.messages.push(...reload.newMessages, { role: 'assistant', content: 'Reloaded.' });
    session.messages.push({ role: 'user', content: 'Continue.' });
    assert.deepEqual(appendSkillUpdateNotices(session.messages, root), []);

    // A further change notifies again, once.
    write('guide', '# Guide v3\nRULE_THREE');
    assert.equal(appendSkillUpdateNotices(session.messages, root).length, 1);
    assert.deepEqual(appendSkillUpdateNotices(session.messages, root), []);
    assert.equal(notices(session.messages).length, 2);
    assert.equal(
      notices(session.messages).every((m) => m.meta.skill === 'guide'),
      true
    );

    // Switched off: one notice that its instructions are no longer in force.
    patchSkillsDisabled(['guide']);
    const off = appendSkillUpdateNotices(session.messages, root);
    assert.equal(off.length, 1);
    assert.match(off[0].content, /Skill "guide" is no longer available/);
    assert.deepEqual(appendSkillUpdateNotices(session.messages, root), []);
  });
});

test('switching a loaded skill off, on unchanged and off again notifies each transition once', async () => {
  await withSkills(async ({ root, write }) => {
    write('guide', '# Guide\nRULE');
    const session = newSession(root);
    await load(session, 'guide');
    const before = structuredClone(session.messages);
    const step = (disabled) => {
      patchSkillsDisabled(disabled);
      const told = appendSkillUpdateNotices(session.messages, root);
      assert.deepEqual(appendSkillUpdateNotices(session.messages, root), [], 'not repeated');
      return told.map((m) => m.content);
    };
    const [off] = step(['guide']);
    assert.match(off, /is no longer available/);
    const [on, ...extra] = step([]);
    assert.match(on, /Skill "guide" is available again, unchanged/);
    assert.deepEqual(extra, []);
    assert.match(step(['guide'])[0], /is no longer available/);
    assert.equal(notices(session.messages).length, 3);
    assert.deepEqual(session.messages.slice(0, before.length), before, 'earlier messages unchanged');
  });
});
