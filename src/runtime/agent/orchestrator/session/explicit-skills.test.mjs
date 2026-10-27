// Isolate Mixdog user data in a temp dir before any module under test loads.
import '../../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skillSelectionHeader, selectedSkillName } from '../../../shared/skill-selection.mjs';
import { invalidateSkillsCache } from '../context/collect.mjs';
import { latestSkillBodies } from '../context/skill-state.mjs';
import { prepareExplicitSkills, recordAppliedSkills } from './explicit-skills.mjs';
import { restoreTranscriptItems } from './transcript-restore/restore.mjs';
import { SKILL_TOOL } from '../runtime-core/tool-defs.mjs';
import { applyDeferredToolSurface, snapshotProviderRequestTools } from '../runtime-core/tool-catalog.mjs';
import { buildRequestBody } from '../providers/openai-responses-payload.mjs';
import { toAnthropicMessages } from '../providers/lib/anthropic-request-utils.mjs';
import { prepareProviderPrefixGuard } from './provider-prefix-guard.mjs';
import { agentLoop } from './agent-loop.mjs';

const BODY = '# Selected guide\nUse the selected procedure, not a substitute.';
const office = {
  name: 'office',
  description: 'Create a document.',
  inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
};
const read = {
  name: 'read',
  description: 'Read a file.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object', properties: {} },
};

async function withSkill(run) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-explicit-skill-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  const dir = join(root, 'skills', 'selected-guide');
  mkdirSync(dir, { recursive: true });
  const write = (body) => {
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: selected-guide\ndescription: Exercise explicit skill selection.\ndependencies:\n  tools:\n    - type: tool\n      value: office\n---\n${body}\n`
    );
    invalidateSkillsCache(root);
  };
  write(BODY);
  try {
    await run({ root, write });
  } finally {
    invalidateSkillsCache(root);
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

function newSession(provider, root) {
  const session = {
    provider,
    cwd: root,
    toolSpec: 'full',
    tools: [SKILL_TOOL, office, read],
    messages: [{ role: 'system', content: 'Stable instructions and skill catalog.' }],
    compaction: { auto: false },
  };
  applyDeferredToolSurface(session, 'full');
  session.liveTurnMessages = session.messages;
  return session;
}

const requestTools = (session) =>
  snapshotProviderRequestTools({
    provider: session.provider,
    tools: session.tools,
    messages: session.messages,
    session,
  });
const bodies = (session) =>
  session.messages.filter(
    (message) => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('<skill>')
  );

test('only a leading explicit selection is syntax, with multimodal content and escaped names supported', () => {
  const name = 'a "quoted" skill';
  assert.equal(selectedSkillName(`${skillSelectionHeader(name)}Work`), name);
  assert.equal(
    selectedSkillName([
      { type: 'text', text: skillSelectionHeader(name) },
      { type: 'image', data: 'x' },
    ]),
    name
  );
  for (const prompt of [
    'Please discuss Skill: "pdf"',
    'Skill: broken\n\nWork',
    'Skill: ""\n\nWork',
    '```\nSkill: "pdf"\n\n```',
    'Quoted:\nSkill: "pdf"\n\nWork',
    [
      { type: 'image', data: 'x' },
      { type: 'text', text: skillSelectionHeader('pdf') },
    ],
  ])
    assert.equal(selectedSkillName(prompt), null);
});

test('explicit preparation is append-only and the first model request has the body and valid native schemas', async () => {
  await withSkill(async ({ root }) => {
    for (const provider of ['openai-oauth', 'anthropic-oauth', 'gemini', 'openrouter']) {
      const session = newSession(provider, root);
      const prompt = `${skillSelectionHeader('selected-guide')}Create the document.`;
      session.messages.push({ role: 'user', content: prompt });
      const prefix = structuredClone(session.messages);
      const tools = requestTools(session);
      const cacheBreaks = [];
      const before = prepareProviderPrefixGuard(null, session.messages, { tools }, { provider });
      await prepareExplicitSkills(prompt, session.messages, session);
      assert.deepEqual(session.messages.slice(0, prefix.length), prefix);
      prepareProviderPrefixGuard(
        before,
        session.messages,
        { tools: requestTools(session) },
        { provider, onCacheBreak: (event) => cacheBreaks.push(event) }
      );
      assert.deepEqual(cacheBreaks, []);
      assert.equal(bodies(session).length, 1);
      assert.ok(bodies(session)[0].content.includes(BODY));
      let sends = 0;
      await agentLoop(
        {
          name: provider,
          async send(messages, _model, sentTools) {
            sends += 1;
            assert.equal(JSON.stringify(messages).split('Selected guide').length - 1, 1);
            if (provider === 'openai-oauth') {
              const payload = buildRequestBody(messages, 'gpt-6-astra', sentTools);
              const call = payload.input.find((item) => item.type === 'function_call' && item.name === 'Skill');
              const output = payload.input.find((item) => item.type === 'function_call_output');
              const load = payload.input.find((item) => item.type === 'tool_search_output');
              assert.ok(call);
              assert.equal(output.call_id, call.call_id);
              assert.equal(load.call_id, `${call.call_id}_load`);
              assert.deepEqual(load.tools.find((tool) => tool.name === 'office').parameters, office.inputSchema);
              assert.deepEqual(payload.tools, buildRequestBody(prefix, 'gpt-6-astra', tools).tools);
            } else if (provider === 'anthropic-oauth') {
              assert.ok(
                JSON.stringify(toAnthropicMessages(messages, sentTools)).includes(
                  '"tool_reference","tool_name":"office"'
                )
              );
              assert.equal(sentTools.find((tool) => tool.name === 'office').deferLoading, true);
            }
            return { content: 'Done.', toolCalls: [], stopReason: 'end_turn' };
          },
        },
        session.messages,
        'fake-model',
        session.tools,
        null,
        root,
        { session }
      );
      assert.equal(sends, 1, 'preparation must not consume a model round-trip');
    }
  });
});

test('repeat, resume and edited skills reuse only current bodies without rewriting previous requests', async () => {
  await withSkill(async ({ root, write }) => {
    let session = newSession('openai-oauth', root);
    const prompt = `${skillSelectionHeader('selected-guide')}Work`;
    session.messages.push({ role: 'user', content: prompt });
    await prepareExplicitSkills(prompt, session.messages, session);
    const calls = session.messages.filter((message) => message.toolCalls?.length).length;
    // Resume has no process-local skill registry: only durable messages.
    session = { ...session, messages: JSON.parse(JSON.stringify(session.messages)) };
    session.liveTurnMessages = session.messages;
    const before = structuredClone(session.messages);
    session.messages.push({ role: 'user', content: prompt });
    await prepareExplicitSkills(prompt, session.messages, session);
    assert.deepEqual(session.messages.slice(0, before.length), before);
    assert.equal(bodies(session).length, 1);
    assert.equal(session.messages.filter((message) => message.toolCalls?.length).length, calls);
    write('# Updated guide\nUse the revised procedure.');
    session.messages.push({ role: 'user', content: prompt });
    await prepareExplicitSkills(prompt, session.messages, session);
    assert.equal(bodies(session).length, 2);
    assert.equal(latestSkillBodies(session.messages).length, 1);
    assert.match(latestSkillBodies(session.messages)[0].message.content, /revised procedure/);
    assert.deepEqual(session.messages.slice(0, before.length), before);
  });
});

test('ordinary follow-up turns retain reusable skills without loading or appending reminders', async () => {
  await withSkill(async ({ root }) => {
    for (const provider of ['openai-oauth', 'anthropic-oauth']) {
      const session = newSession(provider, root);
      const selected = `${skillSelectionHeader('selected-guide')}Start the task.`;
      session.messages.push({ role: 'user', content: selected });
      await prepareExplicitSkills(selected, session.messages, session);
      session.messages.push({ role: 'assistant', content: 'Ready.' });

      for (const prompt of [
        'Continue the same task.',
        'Use selected-guide for the next step too.',
        'Switch to an unrelated task.',
      ]) {
        session.messages.push({ role: 'user', content: prompt });
        const before = structuredClone(session.messages);
        await prepareExplicitSkills(prompt, session.messages, session, {
          execute() {
            assert.fail('an ordinary follow-up must not execute Skill');
          },
        });
        assert.deepEqual(session.messages, before);
        assert.equal(latestSkillBodies(session.messages).length, 1);
        session.messages.push({ role: 'assistant', content: 'Done.' });
      }
    }
  });
});

test('concurrent equivalent Skill calls inject one body even before the batch is flushed', async () => {
  await withSkill(async ({ root }) => {
    const session = newSession('openai-oauth', root);
    session.messages.push({ role: 'user', content: 'Use the selected guide.' });
    let sends = 0;
    await agentLoop(
      {
        name: 'openai-oauth',
        async send(messages) {
          sends += 1;
          if (sends === 1)
            return {
              content: '',
              toolCalls: [
                { id: 'first', name: 'Skill', arguments: { name: 'selected-guide' } },
                { id: 'second', name: 'Skill', arguments: { name: ' selected-guide ' } },
              ],
            };
          assert.equal(JSON.stringify(messages).split('Selected guide').length - 1, 1);
          return { content: 'Done.', toolCalls: [], stopReason: 'end_turn' };
        },
      },
      session.messages,
      'fake-model',
      session.tools,
      null,
      root,
      { session }
    );
    assert.equal(sends, 2);
    assert.equal(bodies(session).length, 1);
  });
});

test('queued selections are prepared before continuation, while task notifications cannot select skills', async () => {
  await withSkill(async ({ root }) => {
    const session = newSession('openai-oauth', root);
    session.messages.push({ role: 'user', content: 'First task' });
    const executed = [];
    session.beforeToolHook = async (call) => {
      executed.push(call.args.name);
      return { action: 'allow' };
    };
    let sends = 0;
    let drained = false;
    await agentLoop(
      {
        name: 'openai-oauth',
        async send(messages) {
          sends += 1;
          if (sends === 1) assert.equal(latestSkillBodies(session.messages).length, 0);
          else assert.equal(JSON.stringify(messages).split('Selected guide').length - 1, 1);
          return { content: 'Done.', toolCalls: [], stopReason: 'end_turn' };
        },
      },
      session.messages,
      'fake-model',
      session.tools,
      null,
      root,
      {
        session,
        drainSteering() {
          if (sends !== 1 || drained) return [];
          drained = true;
          return [
            { mode: 'task-notification', content: `${skillSelectionHeader('not-installed')}Finished.` },
            { mode: 'prompt', content: `${skillSelectionHeader('selected-guide')}Next task` },
          ];
        },
      }
    );
    assert.equal(sends, 2);
    assert.deepEqual(executed, ['selected-guide']);
    assert.equal(bodies(session).length, 1);
  });
});

function addSkill(root, name, frontmatter = '') {
  const dir = join(root, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Skill ${name}.\n${frontmatter}---\n# ${name} body\nFollow ${name}.\n`
  );
  invalidateSkillsCache(root);
}

const skillBodyNames = (session) => bodies(session).map((message) => /<name>([^<]+)<\/name>/.exec(message.content)[1]);

test('inline $name mentions load every named skill in first-mention order, deduplicated with the header', async () => {
  await withSkill(async ({ root }) => {
    addSkill(root, 'second-guide');
    for (const provider of ['openai-oauth', 'anthropic-oauth']) {
      // A mid-text mention selects the skill; the prompt itself is not rewritten.
      let session = newSession(provider, root);
      const midText = 'Please follow $selected-guide while you work.';
      session.messages.push({ role: 'user', content: midText });
      const promptIndex = session.messages.length - 1;
      assert.deepEqual(await prepareExplicitSkills(midText, session.messages, session), ['selected-guide']);
      assert.equal(session.messages[promptIndex].content, midText);
      assert.deepEqual(skillBodyNames(session), ['selected-guide']);

      // Two mentions (one inside brackets, one in a later text part) load both, in order.
      session = newSession(provider, root);
      const parts = [
        { type: 'text', text: 'First ($second-guide),' },
        { type: 'text', text: '$selected-guide next.' },
      ];
      assert.deepEqual(await prepareExplicitSkills(parts, session.messages, session), [
        'second-guide',
        'selected-guide',
      ]);
      assert.deepEqual(skillBodyNames(session), ['second-guide', 'selected-guide']);

      // A header selection plus a mention of the same skill loads it once; header first.
      session = newSession(provider, root);
      const executed = [];
      session.beforeToolHook = async (call) => {
        executed.push(call.args.name);
        return { action: 'allow' };
      };
      const mixed = `${skillSelectionHeader('selected-guide')}Use $second-guide and $selected-guide again.`;
      assert.deepEqual(await prepareExplicitSkills(mixed, session.messages, session), [
        'selected-guide',
        'second-guide',
      ]);
      assert.deepEqual(executed, ['selected-guide', 'second-guide']);
      assert.deepEqual(skillBodyNames(session), ['selected-guide', 'second-guide']);
    }
  });
});

test('unknown, shell-like, embedded, disabled and unavailable mentions stay prose', async () => {
  await withSkill(async ({ root }) => {
    addSkill(root, 'off-guide');
    addSkill(root, 'needs-feature', 'metadata:\n  requires: no-such-feature\n');
    const { patchSkillsDisabled } = await import('../config.mjs');
    const backupRoot = process.env.MIXDOG_USER_DATA_BACKUP_ROOT;
    process.env.MIXDOG_USER_DATA_BACKUP_ROOT = join(root, 'backups');
    try {
      patchSkillsDisabled(['off-guide']);
    } finally {
      if (backupRoot === undefined) delete process.env.MIXDOG_USER_DATA_BACKUP_ROOT;
      else process.env.MIXDOG_USER_DATA_BACKUP_ROOT = backupRoot;
    }
    const session = newSession('openai-oauth', root);
    const prompt =
      'Echo $HOME and pay $300 to $unknown-skill; mail me@$selected-guide or a$selected-guide; ' +
      'also $off-guide and $needs-feature and $Selected-guide.';
    const before = structuredClone(session.messages);
    const applied = await prepareExplicitSkills(prompt, session.messages, session, {
      execute() {
        assert.fail('prose mentions must not execute Skill');
      },
    });
    assert.deepEqual(applied, []);
    assert.deepEqual(session.messages, before);
  });
});

test('token boundaries, code and reserved names: prose stays prose, chip selection still works', async () => {
  await withSkill(async ({ root }) => {
    addSkill(root, 'path');
    const session = newSession('openai-oauth', root);
    const executed = [];
    const execute = async (_tool, args) => {
      executed.push(args.name);
      return `Loaded skill: ${args.name}`;
    };
    const prose =
      'Set $path and $PATH, $selected-guide_env, $selected-guideX, `$selected-guide`:\n' + '```\n$selected-guide\n```';
    assert.deepEqual(await prepareExplicitSkills(prose, session.messages, session, { execute }), []);
    assert.deepEqual(executed, []);
    assert.deepEqual(
      await prepareExplicitSkills('결과는 $selected-guide로 정리', session.messages, session, { execute }),
      ['selected-guide']
    );
    // A reserved-name skill is never an inline mention but the header chip selects it.
    assert.deepEqual(
      await prepareExplicitSkills(`${skillSelectionHeader('path')}Work on $path.`, session.messages, session, {
        execute,
      }),
      ['path']
    );
    // Pristine `mixdog exec` isolation: with skills disabled nothing selects.
    const previous = process.env.MIXDOG_DISABLE_SKILLS;
    process.env.MIXDOG_DISABLE_SKILLS = '1';
    try {
      executed.length = 0;
      assert.deepEqual(
        await prepareExplicitSkills(
          `${skillSelectionHeader('selected-guide')}Use $selected-guide.`,
          session.messages,
          session,
          {
            execute,
          }
        ),
        []
      );
      assert.deepEqual(executed, []);
    } finally {
      if (previous === undefined) delete process.env.MIXDOG_DISABLE_SKILLS;
      else process.env.MIXDOG_DISABLE_SKILLS = previous;
    }
  });
});

test('at most five explicit skills are prepared per turn', async () => {
  await withSkill(async ({ root }) => {
    const names = ['g-one', 'g-two', 'g-three', 'g-four', 'g-five', 'g-six', 'g-seven'];
    for (const name of names) addSkill(root, name);
    const session = newSession('openai-oauth', root);
    const executed = [];
    const applied = await prepareExplicitSkills(names.map((name) => `$${name}`).join(' '), session.messages, session, {
      async execute(_tool, args) {
        executed.push(args.name);
        return `Loaded skill: ${args.name}`;
      },
    });
    assert.deepEqual(executed, names.slice(0, 5));
    assert.deepEqual(applied, names.slice(0, 5));
  });
});

test('applied skills are recorded on the steered user row, reported live and restored', async () => {
  await withSkill(async ({ root }) => {
    const session = newSession('openai-oauth', root);
    session.messages.push({ role: 'user', content: 'First task' });
    const reported = [];
    let sends = 0;
    let drained = false;
    await agentLoop(
      {
        name: 'openai-oauth',
        async send() {
          sends += 1;
          return { content: 'Done.', toolCalls: [], stopReason: 'end_turn' };
        },
      },
      session.messages,
      'fake-model',
      session.tools,
      null,
      root,
      {
        session,
        onSkillsApplied: (names, detail) => reported.push({ names, detail }),
        drainSteering() {
          if (sends !== 1 || drained) return [];
          drained = true;
          return [
            {
              mode: 'prompt',
              content: 'Next: use $selected-guide and $unknown-skill.',
              transcriptMeta: { messageId: 'msg_steered' },
            },
          ];
        },
      }
    );
    const steered = session.messages.find((message) => message.meta?.transcript?.messageId === 'msg_steered');
    assert.deepEqual(steered.meta.transcript.appliedSkills, ['selected-guide']);
    assert.equal(steered.content, 'Next: use $selected-guide and $unknown-skill.');
    assert.deepEqual(reported, [{ names: ['selected-guide'], detail: { messageId: 'msg_steered' } }]);
    const restored = restoreTranscriptItems(JSON.parse(JSON.stringify(session.messages)));
    const rows = restored.filter((item) => item.kind === 'user');
    assert.deepEqual(rows.find((item) => item.messageId === 'msg_steered').appliedSkills, ['selected-guide']);
    assert.equal(
      rows.some((item) => item.messageId !== 'msg_steered' && item.appliedSkills),
      false
    );
  });
});

test('header-only selections populate appliedSkills; failed loads never do', async () => {
  await withSkill(async ({ root }) => {
    const message = { role: 'user', content: 'x', meta: { transcript: { messageId: 'msg_header', at: 1 } } };
    const session = newSession('openai-oauth', root);
    const applied = await prepareExplicitSkills(
      `${skillSelectionHeader('selected-guide')}Work`,
      session.messages,
      session
    );
    const list = [message];
    const stamped = recordAppliedSkills(list, message, applied);
    assert.notEqual(stamped, message, 'a new message object, so the delta save re-sends it');
    assert.equal(list[0], stamped);
    assert.deepEqual(stamped.meta.transcript, { messageId: 'msg_header', at: 1, appliedSkills: ['selected-guide'] });
    assert.equal(recordAppliedSkills(list, stamped, []), stamped, 'nothing loaded: unchanged');
    const denied = newSession('openai-oauth', root);
    denied.beforeToolHook = async () => ({ action: 'deny', reason: 'policy' });
    assert.deepEqual(
      await prepareExplicitSkills(`${skillSelectionHeader('selected-guide')}$selected-guide`, denied.messages, denied),
      []
    );
    assert.deepEqual(await prepareExplicitSkills(skillSelectionHeader('not-installed'), denied.messages, denied), []);
  });
});

test('a session that cannot call Skill skips explicit selection entirely and records nothing', async () => {
  await withSkill(async ({ root }) => {
    addSkill(root, 'setup');
    addSkill(root, 'image');
    const prompt = `${skillSelectionHeader('selected-guide')}Use $setup $image $HOME today.`;
    for (const restrict of [
      (session) => {
        session.schemaAllowedTools = ['read', 'office']; // headless allowlist without Skill
      },
      (session) => {
        session.disallowedTools = ['Skill']; // a role that denies it
      },
    ]) {
      const session = newSession('openai-oauth', root);
      restrict(session);
      const user = { role: 'user', content: prompt, meta: { transcript: { messageId: 'm1' } } };
      session.messages.push(user);
      const before = structuredClone(session.messages);
      const applied = await prepareExplicitSkills(prompt, session.messages, session, {
        execute() {
          assert.fail('a session without Skill must not attempt it');
        },
      });
      assert.deepEqual(applied, []);
      assert.deepEqual(session.messages, before, 'no reminder, tool pair or body is pushed');
      assert.equal(recordAppliedSkills(session.messages, user, applied), user);
      assert.equal(user.meta.transcript.appliedSkills, undefined);
    }
    // Control: the same prompt on a session that has Skill loads all three.
    const session = newSession('openai-oauth', root);
    assert.deepEqual(await prepareExplicitSkills(prompt, session.messages, session), [
      'selected-guide',
      'setup',
      'image',
    ]);
    assert.deepEqual(skillBodyNames(session), ['selected-guide', 'setup', 'image']);
  });
});

test('missing, denied and cancelled selections never become successful skill bodies or schema grants', async () => {
  await withSkill(async ({ root }) => {
    {
      const session = newSession('openai-oauth', root);
      session.beforeToolHook = async () => ({ action: 'deny', reason: 'policy' });
      const originalTools = structuredClone(session.tools);
      await prepareExplicitSkills(skillSelectionHeader('selected-guide'), session.messages, session);
      assert.equal(bodies(session).length, 0);
      assert.deepEqual(session.tools, originalTools);
      assert.match(session.messages.at(-1).content, /Error:/);
      assert.equal(
        session.messages.some((message) => message.nativeToolSearch),
        false
      );
    }
    const session = newSession('openai-oauth', root);
    // A header naming no loadable skill is not a selection: nothing executes.
    const untouched = structuredClone(session.messages);
    assert.deepEqual(
      await prepareExplicitSkills(skillSelectionHeader('not-installed'), session.messages, session, {
        execute() {
          assert.fail('an unknown header selection must not execute Skill');
        },
      }),
      []
    );
    assert.deepEqual(session.messages, untouched);
    const before = structuredClone(session.messages);
    await assert.rejects(
      prepareExplicitSkills(skillSelectionHeader('selected-guide'), session.messages, session, {
        signal: AbortSignal.abort(new Error('cancelled')),
      }),
      /cancelled/
    );
    assert.deepEqual(session.messages, before);
    session.toolSpec = 'readonly';
    await prepareExplicitSkills(skillSelectionHeader('selected-guide'), session.messages, session);
    assert.equal(bodies(session).length, 1);
    assert.ok(session.messages.some((message) => /Required tools unavailable/.test(message.content)));
    assert.equal(session.deferredCallableTools?.includes('office') || false, false);
  });
});

test('out-of-scope skills are refused for header, inline and model-requested loads', async () => {
  await withSkill(async ({ root }) => {
    addSkill(root, 'scoped-guide');
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    const { loadConfig, saveConfig } = await import('../config.mjs');
    const backupRoot = process.env.MIXDOG_USER_DATA_BACKUP_ROOT;
    process.env.MIXDOG_USER_DATA_BACKUP_ROOT = join(root, 'backups');
    try {
      saveConfig({
        ...loadConfig({ secrets: false }),
        extensionScopes: { skills: { 'scoped-guide': [elsewhere] } },
      });
    } finally {
      if (backupRoot === undefined) delete process.env.MIXDOG_USER_DATA_BACKUP_ROOT;
      else process.env.MIXDOG_USER_DATA_BACKUP_ROOT = backupRoot;
    }
    invalidateSkillsCache(root);
    const prompt = `${skillSelectionHeader('scoped-guide')}Use $scoped-guide and $selected-guide.`;

    // Header and inline selection outside the scope: not selected, not executed.
    const outside = newSession('openai-oauth', root);
    const executed = [];
    const applied = await prepareExplicitSkills(prompt, outside.messages, outside, {
      async execute(_tool, args) {
        executed.push(args.name);
        return `Loaded skill: ${args.name}`;
      },
    });
    assert.deepEqual(executed, ['selected-guide']);
    assert.deepEqual(applied, ['selected-guide']);

    // Inside the scope the same prompt selects it, header first.
    const inside = newSession('openai-oauth', elsewhere);
    assert.deepEqual(await prepareExplicitSkills(prompt, inside.messages, inside, { cwd: elsewhere }), [
      'scoped-guide',
      'selected-guide',
    ]);

    // The loading boundary itself refuses a model-requested out-of-scope load
    // with a clear result, and still loads in-scope skills.
    const { viewSkill } = await import('./loop/tool-helpers.mjs');
    assert.match(
      String(viewSkill(root, 'scoped-guide')),
      /^Error: skill "scoped-guide" is not available in this project/
    );
    assert.doesNotMatch(String(viewSkill(elsewhere, 'scoped-guide')), /^Error:/);
    assert.doesNotMatch(String(viewSkill(root, 'selected-guide')), /^Error:/);
    const contextMod = await import('../context/collect.mjs');
    const { createSkillsApi } = await import('../../../../session-runtime/skills-api.mjs');
    const here = createSkillsApi({ contextMod, getCwd: () => root });
    assert.match(String(here.skillToolContent('scoped-guide', null)), /is not available in this project/);
    assert.equal(typeof here.skillToolContent('selected-guide', null), 'object');
    const there = createSkillsApi({ contextMod, getCwd: () => elsewhere });
    assert.equal(typeof there.skillToolContent('scoped-guide', null), 'object');
  });
});
