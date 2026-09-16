import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStandaloneHookBus } from '../hook-bus.mjs';

const standard = (tool = 'fixture_yes') => ({
  hooks: { PreToolUse: [{ matcher: 'read', hooks: [{ type: 'mcp_tool', tool }] }] },
});
const rule = { tool: 'read', action: 'deny', enabled: true, reason: 'fixture rule' };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-hook-config-'));
  const data = join(root, 'data');
  const project = join(root, 'project');
  await Promise.all([mkdir(data), mkdir(join(project, '.mixdog'), { recursive: true })]);
  const path = join(data, 'hooks.json');
  const previous = process.env.MIXDOG_HOOKS_FILE;
  process.env.MIXDOG_HOOKS_FILE = path;
  const buses = [];
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const bus of buses) {
      try {
        bus.flushRules();
      } catch {}
    }
    if (previous === undefined) delete process.env.MIXDOG_HOOKS_FILE;
    else process.env.MIXDOG_HOOKS_FILE = previous;
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    data,
    project,
    path,
    write: (value) => writeFile(path, JSON.stringify(value)),
    read: async () => JSON.parse(await readFile(path, 'utf8')),
    bus(options = {}) {
      const bus = createStandaloneHookBus({
        dataDir: data,
        mcpToolRunner: async ({ name }) =>
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: name === 'fixture_yes' ? 'ask' : 'deny',
              permissionDecisionReason: name,
            },
          }),
        ...options,
      });
      buses.push(bus);
      return bus;
    },
    run: (bus) => bus.beforeTool({ name: 'read', args: { file_path: 'fixture.txt' }, cwd: project }),
  };
}

for (const initiallyTrusted of [true, false]) {
  test(`project trust ${initiallyTrusted ? 'revocation' : 'grant'} invalidates cached hook authority`, async (t) => {
    const f = await fixture(t);
    delete process.env.MIXDOG_HOOKS_FILE;
    await writeFile(join(f.project, '.mixdog/hooks.json'), JSON.stringify(standard()));
    const trustPath = join(f.data, 'config.json');
    const setTrust = (trusted) =>
      writeFile(
        trustPath,
        JSON.stringify({
          trustedProjects: trusted ? [f.project] : [],
        })
      );
    await setTrust(initiallyTrusted);
    let calls = 0;
    const bus = f.bus({
      mcpToolRunner: async () => {
        calls++;
        return '{}';
      },
    });
    await f.run(bus);
    assert.equal(calls, initiallyTrusted ? 1 : 0);
    await setTrust(!initiallyTrusted);
    await f.run(bus);
    assert.equal(calls, 1);
  });
}

test('same-size same-mtime file replacement refreshes hook policy', async (t) => {
  const f = await fixture(t);
  await f.write(standard());
  const fixedTime = new Date('2026-01-01T00:00:00Z');
  await utimes(f.path, fixedTime, fixedTime);
  const bus = f.bus();
  assert.equal((await f.run(bus)).action, 'ask');
  const before = await stat(f.path);
  const replacement = join(f.data, 'replacement.json');
  await writeFile(replacement, JSON.stringify(standard('fixture_nay')));
  await utimes(replacement, before.atime, before.mtime);
  await rename(replacement, f.path);
  const after = await stat(f.path);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal((await f.run(bus)).action, 'deny');
});

test('temporary hook read failures do not become a permanent cached policy omission', async (t) => {
  const f = await fixture(t);
  await f.write(standard());
  const original = fs.readFileSync;
  let blocked = true;
  t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (blocked && String(path) === f.path) {
      throw Object.assign(new Error('fixture read denied'), { code: 'EACCES' });
    }
    return original(path, ...args);
  });
  syncBuiltinESMExports();
  const bus = f.bus();
  assert.ok(bus.status().errors.length > 0);
  blocked = false;
  assert.equal((await f.run(bus)).action, 'ask');
});

test('rule edits preserve standard handlers and unrelated hook settings', async (t) => {
  const f = await fixture(t);
  const original = { ...standard(), disableAllHooks: true, userMetadata: { keep: 'intact' } };
  await f.write(original);
  const bus = f.bus();
  bus.addRule(rule);
  const saved = await f.read();
  assert.deepEqual(saved.hooks, original.hooks);
  assert.equal(saved.disableAllHooks, true);
  assert.deepEqual(saved.userMetadata, original.userMetadata);
  assert.equal(saved.toolBefore.length, 1);
});

test('a failed rule flush reports failure and retains its pending update for retry', async (t) => {
  const f = await fixture(t);
  await f.write({ toolBefore: [rule] });
  const bus = f.bus();
  bus.setRuleEnabled(0, false);
  const original = fs.writeFileSync;
  let blocked = true;
  t.mock.method(fs, 'writeFileSync', (...args) => {
    if (blocked) throw Object.assign(new Error('fixture disk failure'), { code: 'EIO' });
    return original(...args);
  });
  syncBuiltinESMExports();
  assert.throws(() => bus.flushRules(), { code: 'EIO' });
  blocked = false;
  bus.flushRules();
  assert.equal((await f.read()).toolBefore[0].enabled, false);
});

test('pending rule toggles do not resurrect an externally deleted hooks file', async (t) => {
  const f = await fixture(t);
  await f.write({ toolBefore: [rule] });
  const bus = f.bus();
  bus.setRuleEnabled(0, false);
  await unlink(f.path);
  assert.throws(() => bus.flushRules(), { code: 'HOOK_RULE_CONFLICT' });
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
});

for (const prepend of [false, true]) {
  test(`pending toggles ${prepend ? 'reject shifted indexes' : 'retain appended rules'} after an external edit`, async (t) => {
    const f = await fixture(t);
    await f.write({ toolBefore: [rule] });
    const bus = f.bus();
    bus.setRuleEnabled(0, false);
    const added = { tool: 'edit', action: 'deny', enabled: true };
    const external = { toolBefore: prepend ? [added, rule] : [rule, added] };
    await f.write(external);
    if (prepend) {
      assert.throws(() => bus.flushRules(), { code: 'HOOK_RULE_CONFLICT' });
      assert.deepEqual(await f.read(), external);
    } else {
      bus.flushRules();
      assert.deepEqual((await f.read()).toolBefore, [{ ...rule, enabled: false }, added]);
    }
  });
}

test('a disabled rule stops applying immediately, before its debounced save', async (t) => {
  const f = await fixture(t);
  await f.write({ toolBefore: [rule] });
  const bus = f.bus();
  assert.equal((await f.run(bus)).action, 'deny');
  bus.setRuleEnabled(0, false);
  assert.equal(await f.run(bus), null);
});

for (const [name, document] of [
  ['array', (rules) => rules],
  ['toolBefore', (rules) => ({ toolBefore: rules, keep: true })],
  ['beforeTool', (rules) => ({ beforeTool: rules, keep: true })],
  ['nested toolBefore', (rules) => ({ hooks: { toolBefore: rules }, keep: true })],
]) {
  test(`rule updates retain the supported ${name} document format`, async (t) => {
    const f = await fixture(t);
    await f.write(document([rule]));
    const bus = f.bus();
    bus.setRuleEnabled(0, false);
    bus.flushRules();
    assert.deepEqual(await f.read(), document([{ ...rule, enabled: false }]));
  });
}
