// The shell tool's optional `cwd`: where one command runs. Omitted it is the
// session cwd; relative resolves against it; a bad path fails before spawning;
// background runs, task records and hooks all see the effective directory.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test, { after } from 'node:test';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-shell-cwd-')));
const environment = {
  MIXDOG_DATA_DIR: join(root, 'data'),
  MIXDOG_HOME: join(root, 'home'),
  MIXDOG_USER_DATA_BACKUP_ROOT: join(root, 'backups'),
};
const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
Object.assign(process.env, environment);
after(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
  process.once('exit', () => rmSync(root, { recursive: true, force: true }));
});

const { executeBashTool } = await import('./bash-tool.mjs');
const { executeTool } = await import('../../session/loop/tool-exec.mjs');
const { getBackgroundTask } = await import('../../../../shared/background-tasks.mjs');
const { effectiveShellCwd } = await import('./bash-tool/shell-cwd.mjs');
const { ruleMatches } = await import('../../../../../session-runtime/services/hook-bus/rules.mjs');

const session = join(root, 'session');
const sub = join(session, 'sub');
mkdirSync(sub, { recursive: true });
const other = join(root, 'other');
mkdirSync(other);
writeFileSync(join(root, 'file.txt'), 'x');

const PRINT_CWD = 'node -e "console.log(process.cwd())"';
const PRINT_CWD_LATER = 'node -e "setTimeout(() => console.log(process.cwd()), 400)"';
// A tool result is text or an envelope around it.
const textOf = (output) => (typeof output === 'string' ? output : output.result);
const printed = (output) => textOf(output).split(/\r?\n/).map((line) => line.trim());

test('omitted cwd runs in the session cwd', async () => {
  const out = await executeBashTool({ command: PRINT_CWD }, session, {});
  assert.ok(printed(out).includes(session), out);
});

test('a relative cwd resolves against the session cwd', async () => {
  const out = await executeBashTool({ command: PRINT_CWD, cwd: 'sub' }, session, {});
  assert.ok(printed(out).includes(sub), out);
});

test('an absolute cwd is used as given', async () => {
  const out = await executeBashTool({ command: PRINT_CWD, cwd: other }, session, {});
  assert.ok(printed(out).includes(other), out);
});

test('~ and ~/x expand to the home folder, not a Project folder named ~', async () => {
  const home = homedir();
  assert.equal(effectiveShellCwd({ cwd: '~' }, session), home);
  assert.equal(effectiveShellCwd({ cwd: '~/sub' }, session), join(home, 'sub'));
  if (process.platform === 'win32') assert.equal(effectiveShellCwd({ cwd: '~\\sub' }, session), join(home, 'sub'));
  assert.equal(effectiveShellCwd({ cwd: '~other' }, session), join(session, '~other'));
  const out = await executeBashTool({ command: PRINT_CWD, cwd: '~' }, session, {});
  assert.equal(printed(out).some((line) => line.toLowerCase() === realpathSync(home).toLowerCase()), true, textOf(out));
});

test('edge spaces in a cwd name are kept; only a blank value counts as omitted', async () => {
  assert.equal(effectiveShellCwd({ cwd: ' padded ' }, session), join(session, ' padded '));
  assert.equal(effectiveShellCwd({ cwd: '   ' }, session), session);
  const lead = join(session, ' lead');
  mkdirSync(lead);
  const out = await executeBashTool({ command: PRINT_CWD, cwd: ' lead' }, session, {});
  assert.ok(textOf(out).includes(lead), textOf(out));
});

test('a missing or non-directory cwd is an error naming the path, before spawning', async () => {
  const marker = join(root, 'spawned.txt');
  const command = `node -e "require('fs').writeFileSync(${JSON.stringify(marker.replaceAll(sep, '/'))}, 'x')"`;
  const missing = join(root, 'no-such-dir');
  const missingOut = await executeBashTool({ command, cwd: missing }, session, {});
  assert.match(textOf(missingOut), /^Error:/);
  assert.ok(textOf(missingOut).includes(missing), textOf(missingOut));
  const file = join(root, 'file.txt');
  const fileOut = await executeBashTool({ command, cwd: file }, session, {});
  assert.match(textOf(fileOut), /^Error:/);
  assert.ok(textOf(fileOut).includes(file), textOf(fileOut));
  assert.equal(existsSync(marker), false);
});

test('a backgrounded run keeps the cwd in the process and the task record', async () => {
  const out = await executeBashTool({ command: PRINT_CWD_LATER, cwd: other, background: true }, session, {
    sessionId: 'shell-cwd-bg',
  });
  const taskId = /task_id: (\S+)/.exec(textOf(out))?.[1];
  assert.ok(taskId, out);
  const task = getBackgroundTask(taskId);
  assert.equal(task.meta.cwd, other);
  assert.equal(task.input.cwd, other);
  const { executeTaskTool } = await import('./bash-tool.mjs');
  const waited = await executeTaskTool({ action: 'wait', task_id: taskId, timeout_ms: 20_000 }, { sessionId: 'shell-cwd-bg' });
  assert.ok(printed(waited).includes(other), waited);
});

test('a hook rule matching cwd sees the effective cwd', async () => {
  const rule = { tool: 'shell', cwd: `${sep}other`, action: 'deny', reason: 'other is off limits' };
  const seen = [];
  const hookSession = { id: 'shell-cwd-hook', cwd: session };
  const beforeToolHook = (input) => {
    seen.push(input.cwd);
    return ruleMatches(rule, input) ? { action: 'deny', reason: rule.reason } : null;
  };
  const afterSeen = [];
  const afterToolHook = (input) => {
    afterSeen.push(input.cwd);
  };
  const hooks = { beforeToolHook, afterToolHook };

  const denied = await executeTool('shell', { command: PRINT_CWD, cwd: other }, session, hookSession.id, hookSession, hooks);
  assert.match(textOf(denied), /denied by hook: other is off limits/);
  assert.deepEqual(seen, [other]);

  const allowed = await executeTool('shell', { command: PRINT_CWD }, session, hookSession.id, hookSession, hooks);
  assert.ok(printed(allowed).includes(session), allowed);
  assert.deepEqual(seen, [other, session]);

  const relative = await executeTool('shell', { command: PRINT_CWD, cwd: 'sub' }, session, hookSession.id, hookSession, hooks);
  assert.ok(printed(relative).includes(sub), relative);
  assert.deepEqual(seen, [other, session, sub]);
  assert.deepEqual(afterSeen, [session, sub]);
});

test('an empty or non-string cwd is rejected as an argument error', async () => {
  const { executeBuiltinTool } = await import('../builtin.mjs');
  for (const cwd of ['', 7]) {
    const out = await executeBuiltinTool('shell', { command: PRINT_CWD, cwd }, session, {});
    assert.match(textOf(out), /shell arg "cwd" must be a non-empty string/);
  }
});
