// Shell misuse guards: a long leading sleep is rejected, a plain leading `cd`
// moves into `cwd` (hooks, task records and results see the moved call), and a
// shell file read gets a note — or a block in reject mode.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-shell-misuse-')));
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
});

const { guardShellCall, requestedShellType, SHELL_FILE_READ_MODE, SHELL_FILE_READ_NOTE } = await import(
  './misuse-guard.mjs'
);
const { executeBashTool, executeTaskTool } = await import('../bash-tool.mjs');
const { executeTool } = await import('../../../session/loop/tool-exec.mjs');
const { resolveShellFor } = await import('../shell-runtime.mjs');
const { getBackgroundTask } = await import('../../../../../shared/background-tasks.mjs');

const POWERSHELL = 'powershell';
const POSIX = 'posix';
const session = join(root, 'session');
const sub = join(session, 'sub');
mkdirSync(sub, { recursive: true });
const dataFile = join(sub, 'data.txt');
writeFileSync(dataFile, 'file-body-marker\n');

const PRINT_CWD = 'node -e "console.log(process.cwd())"';
const textOf = (output) => (typeof output === 'string' ? output : output.result);
const guard = (command, shellType, extra = {}) => guardShellCall({ command, ...extra.args }, { shellType, ...extra });
const blockedSleep = (seconds) =>
  `Blocked: a leading sleep of ${seconds} s. Run the step with background:true and wait with task wait (or poll a condition inside one command with its own deadline).`;

test('a leading sleep of 5 s or more is rejected, alone or followed by statements', () => {
  const rejected = [
    ['Start-Sleep 50; check', 50, POWERSHELL],
    ['Start-Sleep -Seconds 58', 58, POWERSHELL],
    ['Start-Sleep -s 30; npm test', 30, POWERSHELL],
    ['start-sleep -Seconds:12 && echo hi', 12, POWERSHELL],
    ['  sleep 5', 5, POWERSHELL],
    ['Start-Sleep -Milliseconds 5000; x', 5, POWERSHELL],
    ['Start-Sleep -m 7500', 7.5, POWERSHELL],
    ['timeout /t 60', 60, POWERSHELL],
    ['timeout /t 30 /nobreak >nul; x', 30, POWERSHELL],
    ['sleep 30 && check', 30, POSIX],
    ['sleep 60\ngit status', 60, POSIX],
    ['sleep 2m; check', 120, POSIX],
    ['sleep 5.5 || true', 5.5, POSIX],
  ];
  for (const [command, seconds, shellType] of rejected) {
    const out = guard(command, shellType);
    assert.match(out.failure ?? '', /^Error: \[shell-tool-failed\] Blocked: a leading sleep/, command);
    assert.ok(out.failure.includes(blockedSleep(seconds)), `${command}: ${out.failure}`);
  }
});

test('short sleeps and sleeps that do not lead are untouched', () => {
  const allowed = [
    'Start-Sleep 4',
    'Start-Sleep -Seconds 4; check',
    'Start-Sleep -Milliseconds 4999',
    'Start-Sleep -Milliseconds 500; x',
    'sleep 4.9; check',
    'echo start; Start-Sleep 60',
    'npm test && sleep 30',
    'for ($i=0; $i -lt 3; $i++) { Start-Sleep 30 }',
    'npm start | ForEach-Object { Start-Sleep 30 }',
    'while ! ready; do sleep 10; done',
    'timeout 60 npm test',
    'sleepy 60',
    'sleep 60 | cat',
    "node -e 'setTimeout(() => {}, 60000)'",
  ];
  for (const command of allowed) {
    for (const shellType of [POWERSHELL, POSIX]) {
      assert.equal(guard(command, shellType).failure, undefined, command);
    }
  }
});

test('a leading sleep after a moved cd is still leading', () => {
  assert.match(guard('cd sub; Start-Sleep 50; check', POWERSHELL).failure, /leading sleep of 50 s/);
});

test('a plain leading cd moves into cwd with a note', () => {
  const moved = [
    ['cd src; npm test', 'src', 'npm test', POSIX],
    ['cd src && npm test', 'src', 'npm test', POSIX],
    ['cd "my dir"; ls -la', 'my dir', 'ls -la', POSIX],
    ["cd 'my dir' && make", 'my dir', 'make', POSIX],
    ['Set-Location sub; npm test', 'sub', 'npm test', POWERSHELL],
    ['Set-Location -Path sub; npm test', 'sub', 'npm test', POWERSHELL],
    ['set-location "C:\\a b\\c"; x', 'C:\\a b\\c', 'x', POWERSHELL],
    ['cd C:\\proj\\sub; x', 'C:\\proj\\sub', 'x', POWERSHELL],
    ['cd ..; git status', '..', 'git status', POSIX],
    ['cd ~/proj; git status', '~/proj', 'git status', POSIX],
    ['cd ~; ls', '~', 'ls', POSIX],
    ['cd /abs/path && node x.js a; b', '/abs/path', 'node x.js a; b', POSIX],
  ];
  for (const [command, dir, rest, shellType] of moved) {
    const out = guard(command, shellType);
    assert.deepEqual(
      { command: out.args?.command, cwd: out.args?.cwd, notes: out.notes },
      { command: rest, cwd: dir, notes: [`Moved \`cd ${dir}\` into cwd.`] },
      command
    );
  }
});

test('a cd that is not one plain path then ; or && runs unchanged', () => {
  const unchanged = [
    ['cd $env:PROJECT; npm test', POWERSHELL],
    ['cd "$HOME/x"; npm test', POSIX],
    ['cd $(pwd); npm test', POSIX],
    ['cd `pwd`; x', POSIX],
    ['cd; npm test', POSIX],
    ['cd', POSIX],
    ['cd src', POSIX],
    ['cd src;', POSIX],
    ['cd ..; cd x; y', POSIX],
    ['cd a && cd b && y', POSIX],
    ['Set-Location a; Set-Location b; y', POWERSHELL],
    ['cd -; x', POSIX],
    ['cd ~root; x', POSIX],
    ['pushd src; npm test; popd; git status', POSIX],
    ['pushd sub && npm test', POSIX],
    ['Push-Location sub; npm test', POWERSHELL],
    ["cd '~'; x", POSIX],
    ['cd "~"; x', POSIX],
    ['cd "~/x"; x', POSIX],
    ["Set-Location '~'; x", POWERSHELL],
    ['cd src | tee log', POSIX],
    ['cd src || exit 1', POSIX],
    ['cd a b; x', POSIX],
    ['cd src*; x', POSIX],
    ['cd dir\\sub; x', POSIX],
    ['cd /d C:\\x && y', POWERSHELL],
    ['npm test; cd src', POSIX],
    ['echo cd src; x', POSIX],
  ];
  for (const [command, shellType] of unchanged) {
    const out = guard(command, shellType);
    assert.equal(out.args.command, command, command);
    assert.equal(out.args.cwd, undefined, command);
    assert.deepEqual(out.notes, [], command);
  }
});

test('PowerShell wildcard paths are left to Set-Location; a POSIX quoted glob is a literal folder name', () => {
  const powershell = [
    'cd "C:/work/project-*"; node build.js',
    "cd 'C:/work/project-?'; node build.js",
    'Set-Location -Path "C:/work/proj[12]"; node build.js',
    'cd C:/work/proj[12]; node build.js',
    'cd C:/work/project-*; node build.js',
  ];
  for (const command of powershell) {
    const out = guard(command, POWERSHELL);
    assert.equal(out.args.command, command, command);
    assert.equal(out.args.cwd, undefined, command);
    assert.deepEqual(out.notes, [], command);
  }
  // Bash: a quoted glob never expands, so the folder is that literal name;
  // an unquoted one (`*`, `?`, `[`) expands and stays with the shell.
  for (const [command, dir] of [
    ['cd "project-*"; node build.js', 'project-*'],
    ["cd 'proj[12]' && node build.js", 'proj[12]'],
  ]) {
    const out = guard(command, POSIX);
    assert.equal(out.args.command, 'node build.js', command);
    assert.equal(out.args.cwd, dir, command);
  }
  for (const command of ['cd project-*; node build.js', 'cd project-?; x', 'cd proj[12]; x']) {
    const out = guard(command, POSIX);
    assert.equal(out.args.command, command, command);
    assert.equal(out.args.cwd, undefined, command);
  }
});

test('the guard parses with the shell the call asks for, not the default one', () => {
  const windowsPath = 'cd foo\\bar; npm test';
  assert.equal(guard(windowsPath, POWERSHELL).args.cwd, 'foo\\bar');
  if (resolveShellFor('bash')) {
    assert.equal(requestedShellType({ shell: 'bash' }), POSIX);
    const out = guardShellCall(
      { command: windowsPath, shell: 'bash' },
      { shellType: requestedShellType({ shell: 'bash' }) }
    );
    assert.equal(out.args.command, windowsPath);
    assert.equal(out.args.cwd, undefined);
  }
  assert.equal(requestedShellType({}), resolveShellFor('default').shellType);
  assert.equal(requestedShellType({ shell: 'no-such-shell' }), resolveShellFor('default').shellType);
});

test('an explicit cwd keeps a leading cd where it is', () => {
  const out = guard('cd src; npm test', POSIX, { args: { cwd: 'other' } });
  assert.equal(out.args.command, 'cd src; npm test');
  assert.equal(out.args.cwd, 'other');
  assert.deepEqual(out.notes, []);
});

const FLAGGED = {
  [POWERSHELL]: [
    ['Get-Content a.txt', 'read', 'get-content'],
    ['gc "a b.txt" | Select-Object -First 5', 'read', 'gc'],
    ['Get-Content -Path a.txt -TotalCount 5', 'read', 'get-content'],
    ['cat a.txt', 'read', 'cat'],
    ['type a.txt', 'read', 'type'],
    ['Get-Content a.txt | Select-String foo', 'read', 'get-content'],
    ['Get-Content a.txt 2>$null', 'read', 'get-content'],
    ['Select-String -Path a.txt -Pattern foo', 'grep', 'select-string'],
    ['Select-String foo a.txt', 'grep', 'select-string'],
    ['sls foo src\\*.mjs | Select-Object -First 3', 'grep', 'sls'],
    ['Get-ChildItem src', 'list', 'get-childitem'],
    ['ls src', 'list', 'ls'],
    ['dir src -Recurse', 'list', 'dir'],
    ['gci -Path src -Filter *.mjs', 'list', 'gci'],
    ['rg foo src', 'grep', 'rg'],
  ],
  [POSIX]: [
    ['cat a.txt', 'read', 'cat'],
    ['head -n 5 a.txt', 'read', 'head'],
    ['tail -20 a.txt', 'read', 'tail'],
    ['less a.txt', 'read', 'less'],
    ['cat a.txt | head -3', 'read', 'cat'],
    ['grep foo a.txt', 'grep', 'grep'],
    ['grep -rn foo src', 'grep', 'grep'],
    ['rg -t js foo src', 'grep', 'rg'],
    ['ls src', 'list', 'ls'],
    ['ls -la src', 'list', 'ls'],
    ['find . -name "*.mjs"', 'list', 'find'],
  ],
};
const NOT_FLAGGED = {
  [POWERSHELL]: [
    'node x.js | Select-String foo',
    'npm test 2>&1 | Select-String fail',
    'git log | Select-Object -First 5',
    'Get-Content a.txt | ForEach-Object { $_ }',
    'Get-Content a.txt | node x.js',
    'Get-Content a.txt | Set-Content b.txt',
    'Get-Content a.txt | Out-File b.txt',
    'Get-Content a.txt > b.txt',
    'Select-String foo',
    'ls',
    'Get-ChildItem',
    'Get-Process | Select-String node',
    'npm test',
    'echo hi; Get-Content a.txt',
    'Remove-Item a.txt',
  ],
  [POSIX]: [
    'git log | grep fix',
    'node x.js | head -5',
    'cat a.txt | python3 x.py',
    'cat a.txt > b.txt',
    'cat a.txt >> b.txt',
    'cat a.txt | tee b.txt',
    'cat <<EOF > f.txt\nhi\nEOF',
    'cat',
    'head -5',
    'head -n 5',
    'tail -n +5',
    'tail -20',
    'grep foo',
    'rg foo',
    'ls',
    'find . -name "*.tmp" -delete',
    'find . -name x -exec rm {} ;',
    'npm test',
    'echo hi; cat a.txt',
  ],
};

test('a shell file read as the first stage is flagged with the tool that does the job', () => {
  for (const shellType of [POWERSHELL, POSIX]) {
    for (const [command, tool, name] of FLAGGED[shellType]) {
      const telemetry = {};
      const out = guard(command, shellType, { telemetry, agent: 'worker-1', sessionId: 'sess-1' });
      assert.deepEqual(out.notes, [SHELL_FILE_READ_NOTE], `${shellType}: ${command}`);
      assert.equal(out.args.command, command);
      assert.deepEqual(
        telemetry.shellMisuse,
        [{ kind: 'file-read', mode: 'warn', tool, command: name, agent: 'worker-1', sessionId: 'sess-1' }],
        `${shellType}: ${command}`
      );
    }
  }
});

test('piped program output, writes and reads that feed a program are not flagged', () => {
  for (const shellType of [POWERSHELL, POSIX]) {
    for (const command of NOT_FLAGGED[shellType]) {
      const telemetry = {};
      const out = guard(command, shellType, { telemetry });
      assert.deepEqual(out.notes, [], `${shellType}: ${command}`);
      assert.equal(telemetry.shellMisuse, undefined, `${shellType}: ${command}`);
    }
  }
});

test('warn is the shipped mode and the note text is exact', () => {
  assert.equal(SHELL_FILE_READ_MODE, 'warn');
  assert.equal(SHELL_FILE_READ_NOTE, 'Note: use the read / grep / list tools for files instead of the shell.');
});

test('reject mode blocks a flagged read without a note and still records it', () => {
  for (const shellType of [POWERSHELL, POSIX]) {
    for (const [command, tool] of FLAGGED[shellType]) {
      const telemetry = {};
      const out = guard(command, shellType, { fileReadMode: 'reject', telemetry });
      assert.match(out.failure ?? '', /^Error: \[shell-tool-failed\] Blocked: use read \/ grep \/ list/, command);
      assert.equal(out.args, undefined);
      assert.equal(telemetry.shellMisuse[0].mode, 'reject');
      assert.equal(telemetry.shellMisuse[0].tool, tool);
    }
    for (const command of NOT_FLAGGED[shellType]) {
      assert.equal(guard(command, shellType, { fileReadMode: 'reject' }).failure, undefined, command);
    }
  }
});

// ── through the tool ────────────────────────────────────────────────────────

test('a leading sleep is rejected before hooks, approvals and execution', async () => {
  const seen = [];
  const hookSession = { id: 'misuse-sleep', cwd: session };
  const hooks = { beforeToolHook: (input) => seen.push(input), toolApprovalHook: () => seen.push('approval') };
  const out = await executeTool(
    'shell',
    { command: 'Start-Sleep 50; echo ran' },
    session,
    hookSession.id,
    hookSession,
    hooks
  );
  assert.ok(textOf(out).includes(blockedSleep(50)), textOf(out));
  assert.doesNotMatch(textOf(out), /\bran\b$/m);
  assert.deepEqual(seen, []);
  const direct = await executeBashTool({ command: 'sleep 30; echo ran' }, session, {});
  assert.ok(textOf(direct).includes(blockedSleep(30)), textOf(direct));
});

test('hooks, approvals, the result and the task record see the moved cd', async () => {
  const hookSession = { id: 'misuse-cd', cwd: session };
  const before = [];
  const after = [];
  const hooks = {
    beforeToolHook: (input) => {
      before.push({ command: input.args.command, argCwd: input.args.cwd, cwd: input.cwd });
      return null;
    },
    afterToolHook: (input) => {
      after.push({ command: input.args.command, cwd: input.cwd });
    },
  };
  const out = await executeTool(
    'shell',
    { command: `cd sub; ${PRINT_CWD}` },
    session,
    hookSession.id,
    hookSession,
    hooks
  );
  assert.deepEqual(before, [{ command: PRINT_CWD, argCwd: 'sub', cwd: sub }]);
  assert.deepEqual(after, [{ command: PRINT_CWD, cwd: sub }]);
  const text = textOf(out);
  assert.ok(text.includes('Moved `cd sub` into cwd.'), text);
  assert.ok(
    text.split(/\r?\n/).some((line) => line.trim() === sub),
    text
  );
  assert.ok(text.indexOf('Moved') < text.indexOf(sub), 'the note leads the output');

  const ask = [];
  const approving = {
    beforeToolHook: () => ({ action: 'ask', reason: 'confirm' }),
    toolApprovalHook: (request) => {
      ask.push({ command: request.args.command, cwd: request.cwd });
      return { approved: true };
    },
  };
  await executeTool('shell', { command: `cd sub && ${PRINT_CWD}` }, session, hookSession.id, hookSession, approving);
  assert.deepEqual(ask, [{ command: PRINT_CWD, cwd: sub }]);

  const later = 'node -e "setTimeout(() => console.log(process.cwd()), 400)"';
  const started = textOf(
    await executeTool(
      'shell',
      { command: `cd sub; ${later}`, background: true },
      session,
      hookSession.id,
      hookSession,
      {}
    )
  );
  assert.ok(started.includes('Moved `cd sub` into cwd.'), started);
  const taskId = /task_id: (\S+)/.exec(started)?.[1];
  assert.ok(taskId, started);
  const task = getBackgroundTask(taskId);
  assert.doesNotMatch(task.input.command, /cd sub/);
  assert.equal(task.input.cwd, sub);
  await executeTaskTool({ action: 'wait', task_id: taskId, timeout_ms: 20_000 }, { sessionId: hookSession.id });
});

test('a direct call moves the cd too; an explicit cwd leaves it to the shell', async () => {
  const out = await executeBashTool({ command: `cd sub; ${PRINT_CWD}` }, session, {});
  assert.ok(textOf(out).includes('Moved `cd sub` into cwd.'), textOf(out));
  assert.ok(
    textOf(out)
      .split(/\r?\n/)
      .some((line) => line.trim() === sub),
    textOf(out)
  );
  const missing = await executeBashTool({ command: `cd nope; ${PRINT_CWD}` }, session, {});
  assert.match(textOf(missing), /^Error:.*shell cwd ".*nope" does not exist/);
});

test('a file read runs with the note first and is recorded with agent and session', async () => {
  const shellType = resolveShellFor('default').shellType === POWERSHELL ? POWERSHELL : POSIX;
  const command = shellType === POWERSHELL ? `Get-Content "${dataFile}"` : `cat "${dataFile}"`;
  const resultTelemetry = {};
  const out = textOf(
    await executeBashTool({ command }, session, { resultTelemetry, agent: 'worker-9', sessionId: 'sess-9' })
  );
  assert.ok(out.includes('file-body-marker'), out);
  assert.ok(out.includes(SHELL_FILE_READ_NOTE), out);
  assert.ok(out.indexOf(SHELL_FILE_READ_NOTE) < out.indexOf('file-body-marker'));
  assert.equal(resultTelemetry.shellMisuse.length, 1);
  assert.equal(resultTelemetry.shellMisuse[0].agent, 'worker-9');
  assert.equal(resultTelemetry.shellMisuse[0].sessionId, 'sess-9');
  assert.equal(resultTelemetry.shellMisuse[0].kind, 'file-read');

  const clean = textOf(await executeBashTool({ command: PRINT_CWD }, session, { resultTelemetry: {} }));
  assert.ok(!clean.includes(SHELL_FILE_READ_NOTE), clean);
});

test('the note rides a backgrounded read and a moved cd leads a flagged read', async () => {
  const shellType = resolveShellFor('default').shellType === POWERSHELL ? POWERSHELL : POSIX;
  const command = shellType === POWERSHELL ? 'Get-Content data.txt' : 'cat data.txt';
  const sessionId = 'misuse-bg-read';
  const out = textOf(
    await executeBashTool({ command: `cd sub; ${command}`, background: true }, session, { sessionId })
  );
  await executeTaskTool(
    { action: 'wait', task_id: /task_id: (\S+)/.exec(out)?.[1], timeout_ms: 20_000 },
    { sessionId }
  );
  assert.ok(out.includes('Moved `cd sub` into cwd.'), out);
  assert.ok(out.includes(SHELL_FILE_READ_NOTE), out);
  assert.ok(out.indexOf('Moved') < out.indexOf('Note:'));
});
