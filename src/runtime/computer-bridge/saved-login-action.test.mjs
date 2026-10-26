import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { toComputerHostCommand, validateComputerToolArgs } from './action-schema.mjs';
import { endComputerExecution, executeComputerTool, finishComputerTurn, SAVED_LOGIN_OWNER_ID } from './client.mjs';
import { computerResultRecovery, formatComputerToolError } from './error-recovery.mjs';
import { canonicalComputerResultText } from './result-canonical.mjs';
import { TOOL_DEFS } from './tool-defs.mjs';

const args = (input) => ({ action: 'saved_login', input: { window_id: 'hwnd:0x1', ...input } });

test('saved_login names one window, a saved account and which of its values to type', () => {
  for (const field of ['username', 'password']) {
    assert.equal(validateComputerToolArgs(args({ savedAccount: 'j•••e@example.com', field })), null, field);
  }
  // One-time codes stay with the user: no field takes them.
  assert.match(validateComputerToolArgs(args({ savedAccount: 'a@b.c', field: 'code' })), /field/);
  assert.equal(
    validateComputerToolArgs({
      action: 'saved_login',
      input: { app: 'Chrome', savedAccount: 'a@b.c', field: 'password' },
    }),
    null
  );
  assert.match(validateComputerToolArgs(args({ field: 'password' })), /requires input field\(s\): savedAccount/);
  assert.match(validateComputerToolArgs(args({ savedAccount: 'a@b.c' })), /requires input field\(s\): field/);
  assert.match(validateComputerToolArgs(args({ savedAccount: 'a@b.c', field: 'otp' })), /field/);
  assert.match(
    validateComputerToolArgs(args({ savedAccount: '   ', field: 'password' })),
    /savedAccount must not be empty/
  );
  // The value itself is never an input: the host takes it from the vault.
  assert.match(
    validateComputerToolArgs(args({ savedAccount: 'a@b.c', field: 'password', text: 'hunter2' })),
    /does not accept input field\(s\): text/
  );
  assert.match(
    validateComputerToolArgs({ action: 'saved_login', input: { savedAccount: 'a@b.c', field: 'password' } }),
    /exactly one of window_id or app/
  );
});

test('the host receives fill_saved_login, always on the foreground route', () => {
  assert.deepEqual(toComputerHostCommand(args({ savedAccount: 'a@b.c', field: 'username' })), {
    window_id: 'hwnd:0x1',
    field: 'username',
    action: 'fill_saved_login',
    saved_account: 'a@b.c',
    delivery: 'foreground',
  });
  const schema = TOOL_DEFS[0].inputSchema;
  assert.ok(schema.properties.action.enum.includes('saved_login'));
  const text = JSON.stringify(schema);
  assert.match(text, /prefer its existing session\/SSO or Browser Use's saved sign-in/);
  assert.match(
    text,
    /site receives it.*redisplays it can expose it.*same Windows user are outside this protection.*ask_user secret/
  );
  assert.match(
    text,
    /One-time codes, passkeys, security keys and app approvals are the user's step: ask_user takeover/
  );
  // The typing tools steer secrets away from themselves.
  assert.equal(
    (text.match(/Never a password or one-time code, even one shown on screen: saved_login or ask_user/g) || [])
      .length >= 2,
    true
  );
});

test('a fill names its agent turn, and only the turn settlement retires it, even after an abort', {
  timeout: 10_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-saved-login-turn-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = directory;
  const seen = [];
  const owners = [];
  let acceptSettle = false;
  let holdFill = true;
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const command = JSON.parse(body);
      // The owner connection: answered at once, then held open.
      if (request.url === '/owner') {
        owners.push({ ...command, before: seen.length });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{"ok":true}\n');
        return;
      }
      seen.push(command);
      // The first fill never answers: its caller aborts it.
      if (command.action === 'fill_saved_login' && holdFill) return;
      const ok = command.action !== 'turn_settle' || acceptSettle;
      const payload = JSON.stringify(ok ? { ok: true, value: { text: '{"ok":true}' } } : { ok: false, error: 'busy' });
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      response.end(payload);
    });
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    await writeFile(
      join(directory, 'computer-bridge.json'),
      `${JSON.stringify({ version: 1, port: server.address().port, token: 't' })}\n`
    );
    const fill = { action: 'saved_login', input: { window_id: 'hwnd:0x1', savedAccount: 'a@b.c', field: 'password' } };
    const controller = new AbortController();
    const pending = executeComputerTool(fill, { sessionId: 'turn-session', turnId: 7, signal: controller.signal });
    while (!seen.some((command) => command.action === 'fill_saved_login')) await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await pending;
    const sentFill = seen.find((command) => command.action === 'fill_saved_login');
    assert.equal(sentFill.turn_id, 7);
    // The owner connection was attached before the fill left, and both name this process.
    assert.deepEqual(owners, [{ runtime_id: SAVED_LOGIN_OWNER_ID, pid: process.pid, before: 0 }]);
    assert.equal(sentFill.runtime_id, SAVED_LOGIN_OWNER_ID);
    assert.ok(
      seen.some((command) => command.action === 'session_abort'),
      'the cancelled request aborted'
    );
    // The abort was input cleanup; the turn's settlement is still owed and sent.
    await endComputerExecution('turn-session');
    const settles = () => seen.filter((command) => command.action === 'turn_settle');
    assert.deepEqual(settles(), [
      { action: 'turn_settle', session_id: 'turn-session', turn_id: 7, runtime_id: SAVED_LOGIN_OWNER_ID },
    ]);
    // Not accepted: owed again at the next settlement, then cleared.
    acceptSettle = true;
    await endComputerExecution('turn-session');
    assert.equal(settles().length, 2);
    await endComputerExecution('turn-session');
    assert.equal(settles().length, 2, 'an accepted settlement is not sent again');
    // Other actions carry no turn.
    holdFill = false;
    await executeComputerTool({ action: 'list', input: { kind: 'windows' } }, { sessionId: 'turn-session', turnId: 8 });
    assert.equal(seen.at(-1).turn_id, undefined);
    assert.equal(owners.length, 1, 'one owner connection serves every fill of this process');
    // A session's terminal state (manager/runtime-liveness.mjs, lead and
    // sub-agent sessions alike) settles the turn that ended, never a newer one.
    const liveness = await import('../agent/orchestrator/session/manager/runtime-liveness.mjs');
    const session = { id: 'agent-session', usageMetricsTurnId: 3 };
    liveness.configureRuntimeLiveness({ loadSession: (id) => (id === session.id ? session : null) });
    liveness.markSessionAskStart(session.id);
    assert.equal(session.usageMetricsTurnId, 4);
    await executeComputerTool(fill, { sessionId: session.id, turnId: session.usageMetricsTurnId });
    await finishComputerTurn(session.id, 3);
    assert.equal(
      settles().filter((command) => command.session_id === session.id).length,
      0,
      'an older turn ending settles nothing newer'
    );
    liveness.markSessionDone(session.id);
    for (let attempt = 0; attempt < 100 && !settles().some((command) => command.session_id === session.id); attempt++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.deepEqual(
      settles().filter((command) => command.session_id === session.id),
      [{ action: 'turn_settle', session_id: session.id, turn_id: 4, runtime_id: SAVED_LOGIN_OWNER_ID }]
    );
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    await rm(directory, { recursive: true, force: true });
  }
});

test('a desktop that refuses the owner connection receives no fill', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-saved-login-owner-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = directory;
  const seen = [];
  const server = createServer((request, response) => {
    seen.push(request.url);
    request.resume();
    request.on('end', () => {
      const payload = JSON.stringify(
        request.url === '/owner'
          ? { ok: false, error: 'unknown or ended runtime owner' }
          : { ok: true, value: { text: '{}' } }
      );
      response.writeHead(request.url === '/owner' ? 400 : 200, { 'content-type': 'application/json' });
      response.end(payload);
    });
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    await writeFile(
      join(directory, 'computer-bridge.json'),
      `${JSON.stringify({ version: 1, port: server.address().port, token: 't' })}\n`
    );
    const result = await executeComputerTool(
      { action: 'saved_login', input: { window_id: 'hwnd:0x1', savedAccount: 'a@b.c', field: 'password' } },
      { sessionId: 'refused-owner', turnId: 2 }
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /did not accept this runtime as the owner.*no input was sent/);
    assert.deepEqual(seen, ['/owner'], 'the fill itself was never sent');
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    await rm(directory, { recursive: true, force: true });
  }
});

test('a saved-login refusal sends the agent to the user secret handoff', () => {
  const input = args({ savedAccount: 'a@b.c', field: 'password' });
  for (const message of [
    'saved_login_refused: the page is not an HTTPS page; no input was sent',
    'saved_login_changed: the page origin changed since the check; nothing was written',
    'saved_login_unavailable: savedAccount "x" is not a stored login for https://example.com; stored: j•••e@example.com; no input was sent',
  ]) {
    const text = formatComputerToolError(message, input);
    assert.match(text, /Nothing was written/);
    assert.match(text, /ask_user \(kind "secret", surface "computer"\)/);
  }
  // Possibly written: never retried, handed to the user as a takeover.
  const unconfirmed = formatComputerToolError(
    'saved_login_unconfirmed: the saved value may have been written into the checked field, but the field did not confirm it; it is not retried',
    input
  );
  assert.match(unconfirmed, /may have been written.*Do not call saved_login again/);
  assert.match(unconfirmed, /ask_user \(kind "takeover", surface "computer", need "sign_in"\)/);
  const refused = canonicalComputerResultText(
    JSON.stringify({ ok: false, action: 'fill_saved_login', code: 'saved_login_refused' }),
    input
  );
  assert.equal(JSON.parse(refused).action, 'saved_login');
  assert.equal(JSON.parse(refused).recovery.next, 'ask_user');
  assert.equal(computerResultRecovery({ code: 'saved_login_unavailable' }, input).next, 'ask_user');
});
