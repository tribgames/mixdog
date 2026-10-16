import assert from 'node:assert/strict';
import test from 'node:test';

import {
  requiredDesktopCapabilityReadRequests,
  requiredDesktopCapabilityRequest,
  requiredGitBranchName,
  requiredModelSelection,
  requiredNewTaskDraft,
  requiredSubmitOptions,
  requiredTextFileEncoding,
  requiredVisualizeTabCommand,
} from './ipc-validation.ts';

test('an editor save without an encoding change passes the IPC and remote boundaries', () => {
  // IPC keeps `undefined`; the remote lane is JSON and sends `null`.
  assert.equal(requiredTextFileEncoding(undefined), undefined);
  assert.equal(requiredTextFileEncoding(null), undefined);
  for (const encoding of ['utf8', 'utf8bom', 'utf16le', 'utf16be']) {
    assert.equal(requiredTextFileEncoding(encoding), encoding);
  }
  for (const encoding of ['', 'latin1', 0, {}]) {
    assert.throws(() => requiredTextFileEncoding(encoding), TypeError);
  }
});

test('a model route selection carries the per-route autoEffort boolean like fast', () => {
  const base = { provider: 'openai', model: 'gpt-test', effort: 'high', fast: true };
  assert.deepEqual(requiredModelSelection({ ...base, autoEffort: false }), { ...base, autoEffort: false });
  assert.deepEqual(requiredModelSelection(base), base);
  assert.throws(() => requiredModelSelection({ ...base, autoEffort: 'off' }), /autoEffort must be a boolean/);
});

test('saveStarterGuideState passes only a well-formed guide state', () => {
  const save = (state) => requiredDesktopCapabilityRequest({ capability: 'saveStarterGuideState', args: [state] });
  assert.deepEqual(save({ closed: true, welcomed: true, visited: ['provider', 'remote'] }).args, [
    { closed: true, welcomed: true, visited: ['provider', 'remote'] },
  ]);
  for (const bad of [
    'junk',
    null,
    [],
    {},
    { closed: 1, welcomed: true, visited: [] },
    { closed: false, welcomed: false },
    { closed: false, welcomed: false, visited: ['nope'] },
    { closed: false, welcomed: false, visited: [7] },
    { closed: false, welcomed: false, visited: [], extra: true },
  ]) {
    assert.throws(() => save(bad), TypeError, JSON.stringify(bad));
  }
  assert.throws(() => requiredDesktopCapabilityRequest({ capability: 'saveStarterGuideState', args: [] }), TypeError);
});

test('the turn review bar reaches its diff with only a boolean refresh option', () => {
  for (const args of [
    [],
    [{}],
    [{ refresh: true }],
    [{ refresh: false, known: 'a'.repeat(32) }],
    [{ refresh: true, summary: true }],
    [{ refresh: true, summary: true, poll: 'background' }],
  ]) {
    assert.doesNotThrow(() => requiredDesktopCapabilityRequest({ capability: 'getTurnReviewDiff', args }));
  }
  for (const args of [
    [{ refresh: 'yes' }],
    [{ cwd: 'C:/' }],
    [{ known: 'not-a-tag' }],
    [{ summary: 'yes' }],
    [{ poll: 'foreground' }],
    [{ poll: true }],
    [null],
    [[]],
    [{ refresh: true }, {}],
  ]) {
    assert.throws(() => requiredDesktopCapabilityRequest({ capability: 'getTurnReviewDiff', args }), TypeError);
  }
});

test('session usage takes bounded row ids and an optional cumulative-agent flag', () => {
  const read = (args) => requiredDesktopCapabilityRequest({ capability: 'getSessionUsage', args, sessionId: 'lead-1' });
  for (const args of [
    [],
    [{}],
    [{ sessionIds: [] }],
    [{ sessionIds: ['sess_a', 'agent-b'], includeAgents: true }],
    [{ includeAgents: false }],
  ]) {
    assert.doesNotThrow(() => read(args), JSON.stringify(args));
  }
  for (const args of [
    [null],
    [{ sessionIds: 'sess_a' }],
    [{ sessionIds: ['bad id'] }],
    [{ sessionIds: Array.from({ length: 65 }, (_, i) => `s${i}`) }],
    [{ sessionIds: [], days: 1 }],
    [{ includeAgents: 'true' }],
    [{ includeAgents: null }],
    [{}, {}],
  ]) {
    assert.throws(() => read(args), TypeError, JSON.stringify(args));
  }
});

test('Local Provider and Code Tidy lifecycle requests pass the desktop IPC boundary', () => {
  assert.deepEqual(
    requiredDesktopCapabilityRequest({
      capability: 'installBuiltinFeature',
      args: ['localProvider'],
    }),
    {
      capability: 'installBuiltinFeature',
      args: ['localProvider'],
    }
  );
  assert.deepEqual(
    requiredDesktopCapabilityRequest({
      capability: 'setBuiltinToolEnabled',
      args: ['localProvider', false],
    }),
    {
      capability: 'setBuiltinToolEnabled',
      args: ['localProvider', false],
    }
  );
  assert.deepEqual(
    requiredDesktopCapabilityRequest({
      capability: 'installBuiltinFeature',
      args: ['tidy'],
    }),
    {
      capability: 'installBuiltinFeature',
      args: ['tidy'],
    }
  );
  assert.deepEqual(
    requiredDesktopCapabilityRequest({
      capability: 'setBuiltinToolEnabled',
      args: ['tidy', false],
    }),
    {
      capability: 'setBuiltinToolEnabled',
      args: ['tidy', false],
    }
  );
});

test('Code Tidy status reads travel the read lane with no arguments', () => {
  for (const capability of ['getTidyEngineStatus', 'getTidyInstallStatus']) {
    assert.deepEqual(requiredDesktopCapabilityRequest({ capability }), { capability, args: [] });
    assert.deepEqual(requiredDesktopCapabilityReadRequests([{ capability, args: [] }]), [{ capability, args: [] }]);
    assert.throws(
      () => requiredDesktopCapabilityRequest({ capability, args: ['tidy'] }),
      /invalid number of arguments/
    );
  }
});

test('desktop IPC still rejects unknown built-in lifecycle names', () => {
  assert.throws(
    () =>
      requiredDesktopCapabilityRequest({
        capability: 'installBuiltinFeature',
        args: ['thirdPartyRuntime'],
      }),
    /git, memory, office, localProvider, or tidy/
  );
  assert.throws(
    () =>
      requiredDesktopCapabilityRequest({
        capability: 'setBuiltinToolEnabled',
        args: ['thirdPartyRuntime', true],
      }),
    /git, office, localProvider, tidy, autoEffort, or visualize/
  );
});

test('Visualize is a toggle-only built-in: it toggles but never installs', () => {
  assert.deepEqual(
    requiredDesktopCapabilityRequest({ capability: 'setBuiltinToolEnabled', args: ['visualize', false] }),
    { capability: 'setBuiltinToolEnabled', args: ['visualize', false] }
  );
  assert.throws(
    () => requiredDesktopCapabilityRequest({ capability: 'installBuiltinFeature', args: ['visualize'] }),
    /installBuiltinFeature requires/
  );
});

test('visualize tab commands name a session, a tab, and activate or close', () => {
  assert.deepEqual(requiredVisualizeTabCommand({ sessionId: 'sess-1', tabId: 'v2', action: 'close' }), {
    sessionId: 'sess-1',
    tabId: 'v2',
    action: 'close',
  });
  assert.throws(() => requiredVisualizeTabCommand({ sessionId: 'sess-1', tabId: 'v2', action: 'open' }), TypeError);
  assert.throws(() => requiredVisualizeTabCommand({ sessionId: 'sess-1', tabId: '', action: 'close' }), TypeError);
  assert.throws(() => requiredVisualizeTabCommand(null), TypeError);
});

test('visualize version commands carry a kept version number (null = live) and compare', () => {
  const base = { sessionId: 'sess-1', tabId: 'v2' };
  assert.deepEqual(requiredVisualizeTabCommand({ ...base, action: 'version', version: 3, compare: true, extra: 1 }), {
    ...base,
    action: 'version',
    version: 3,
    compare: true,
  });
  assert.deepEqual(requiredVisualizeTabCommand({ ...base, action: 'version', version: null }), {
    ...base,
    action: 'version',
    version: null,
  });
  assert.deepEqual(requiredVisualizeTabCommand({ ...base, action: 'restore', version: 1 }), {
    ...base,
    action: 'restore',
    version: 1,
  });
  for (const version of [0, 1.5, '2', undefined]) {
    assert.throws(() => requiredVisualizeTabCommand({ ...base, action: 'version', version }), TypeError);
  }
  assert.throws(() => requiredVisualizeTabCommand({ ...base, action: 'restore', version: null }), TypeError);
  // A chat card reopens a closed tab's file targets (never URLs, no cwd).
  assert.deepEqual(
    requiredVisualizeTabCommand({
      ...base,
      action: 'reopen',
      targets: ['a.html', 'b.png'],
      label: 'Pair',
      cwd: '/etc',
    }),
    { ...base, action: 'reopen', targets: ['a.html', 'b.png'], label: 'Pair' }
  );
  for (const targets of [[], ['a', 'b', 'c', 'd'], ['http://x/'], [''], 'a.html', [3]]) {
    assert.throws(() => requiredVisualizeTabCommand({ ...base, action: 'reopen', targets }), TypeError);
  }
  // A restore carries the page assets its confirm listed.
  assert.deepEqual(
    requiredVisualizeTabCommand({ ...base, action: 'restore', version: 1, assets: ['site/style.css'] }),
    {
      ...base,
      action: 'restore',
      version: 1,
      assets: ['site/style.css'],
    }
  );
  for (const assets of ['site/style.css', [''], [3], new Array(65).fill('a.css')]) {
    assert.throws(() => requiredVisualizeTabCommand({ ...base, action: 'restore', version: 1, assets }), TypeError);
  }
  assert.throws(
    () => requiredVisualizeTabCommand({ ...base, action: 'version', version: 2, compare: 'yes' }),
    TypeError
  );
  assert.deepEqual(requiredVisualizeTabCommand({ ...base, action: 'network', allow: true, extra: 1 }), {
    sessionId: 'sess-1',
    tabId: 'v2',
    action: 'network',
    allow: true,
  });
  for (const allow of [undefined, 'yes', 1, null]) {
    assert.throws(() => requiredVisualizeTabCommand({ ...base, action: 'network', allow }), TypeError);
  }
});

test('visualize history and export commands validate their payloads', () => {
  assert.deepEqual(requiredVisualizeTabCommand({ sessionId: 'sess-1', action: 'history', entry: 'abc123' }), {
    sessionId: 'sess-1',
    tabId: '',
    action: 'history',
    entry: 'abc123',
  });
  assert.throws(() => requiredVisualizeTabCommand({ sessionId: 'sess-1', action: 'history', entry: '' }), TypeError);
  const base = { sessionId: 'sess-1', tabId: 'v2', action: 'export' };
  assert.deepEqual(requiredVisualizeTabCommand({ ...base, format: 'png', pane: 1 }), {
    ...base,
    format: 'png',
    pane: 1,
  });
  assert.deepEqual(requiredVisualizeTabCommand({ ...base, format: 'project' }), { ...base, format: 'project' });
  for (const format of [undefined, 'gif', 'PNG']) {
    assert.throws(() => requiredVisualizeTabCommand({ ...base, format }), TypeError);
  }
  for (const pane of [-1, 1.5, 99, '1']) {
    assert.throws(() => requiredVisualizeTabCommand({ ...base, format: 'pdf', pane }), TypeError);
  }
});

test('developer settings travel the read lane and option writes require an id and boolean', () => {
  assert.deepEqual(requiredDesktopCapabilityReadRequests([{ capability: 'getDeveloperSettings' }]), [
    { capability: 'getDeveloperSettings', args: [] },
  ]);
  assert.throws(
    () => requiredDesktopCapabilityRequest({ capability: 'getDeveloperSettings', args: ['x'] }),
    /invalid number of arguments/
  );
  assert.deepEqual(
    requiredDesktopCapabilityRequest({ capability: 'setDeveloperOption', args: ['devProviders', true] }),
    {
      capability: 'setDeveloperOption',
      args: ['devProviders', true],
    }
  );
  assert.throws(
    () => requiredDesktopCapabilityRequest({ capability: 'setDeveloperOption', args: ['devProviders', 'on'] }),
    /requires a boolean value/
  );
  assert.throws(
    () => requiredDesktopCapabilityRequest({ capability: 'setDeveloperOption', args: ['  ', false] }),
    /developer option id is invalid/
  );
  assert.throws(
    () => requiredDesktopCapabilityRequest({ capability: 'setDeveloperOption', args: [7, false] }),
    /developer option id must be a string/
  );
  assert.throws(
    () => requiredDesktopCapabilityRequest({ capability: 'setDeveloperOption', args: ['devProviders'] }),
    /invalid number of arguments/
  );
});

test('orchestration modes cross the read/configure and new-task IPC boundaries', () => {
  assert.deepEqual(requiredDesktopCapabilityReadRequests([{ capability: 'getOrchestrationMode' }]), [
    { capability: 'getOrchestrationMode', args: [] },
  ]);
  for (const orchestrationMode of ['none', 'focused', 'balanced', 'swarm']) {
    assert.deepEqual(
      requiredDesktopCapabilityRequest({ capability: 'setOrchestrationMode', args: [orchestrationMode] }),
      { capability: 'setOrchestrationMode', args: [orchestrationMode] }
    );
    assert.deepEqual(requiredNewTaskDraft({ workflowId: 'default', orchestrationMode }), {
      workflowId: 'default',
      orchestrationMode,
    });
  }
  assert.throws(() => requiredNewTaskDraft({ orchestrationMode: 'invalid' }), /orchestrationMode is invalid/);
});

test('git branch validation trims surrounding whitespace without weakening rejection rules', () => {
  assert.equal(requiredGitBranchName('\t feature/topic \n'), 'feature/topic');
  assert.equal(requiredGitBranchName(` ${'x'.repeat(512)} `), 'x'.repeat(512));
  assert.throws(() => requiredGitBranchName(null), { name: 'TypeError', message: 'git branch must be a string.' });
  for (const value of [' \t\n', 'x'.repeat(513), ' -main ', 'fea\0ture', 'fea\nture', 'fea\rture']) {
    assert.throws(() => requiredGitBranchName(value), { name: 'TypeError', message: 'git branch is invalid.' });
  }
});

test('save-as sources accept only http(s) and data URLs', async () => {
  const { requiredSaveSource, requiredAttachmentFile, sanitizedFileName } = await import('./ipc-validation.ts');
  assert.equal(requiredSaveSource('https://example.com/a.txt').kind, 'http');
  assert.equal(requiredSaveSource('data:text/plain;base64,aGk=').bytes.toString(), 'hi');
  assert.equal(requiredSaveSource('data:text/plain,h%20i').bytes.toString(), 'h i');
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://x/y', '', 'nope', 5]) {
    assert.throws(() => requiredSaveSource(bad), TypeError);
  }
  assert.equal(sanitizedFileName('a/b\\c:d.txt'), 'a-b-c-d.txt');
  assert.equal(sanitizedFileName(''), 'download');
  const pdf = requiredAttachmentFile('data:application/pdf;base64,aGk=', 'My Report.PDF');
  assert.equal(pdf.extension, 'pdf');
  assert.equal(pdf.baseName, 'My-Report');
  assert.equal(requiredAttachmentFile('data:application/pdf;base64,aGk=', 'noext').extension, 'pdf');
  // Text-kind attachments off the allowlist open as .txt.
  assert.equal(requiredAttachmentFile('data:text/html;base64,aGk=', 'x.html').extension, 'txt');
  assert.equal(requiredAttachmentFile('data:text/plain;base64,aGk=', 'run.bat').extension, 'txt');
  assert.equal(requiredAttachmentFile('data:text/x-python;base64,aGk=', 'a.py').extension, 'txt');
  assert.equal(requiredAttachmentFile('data:text/plain;base64,aGk=', 'notes.md').extension, 'md');
  assert.equal(
    requiredAttachmentFile(
      'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,aGk=',
      'a.docx'
    ).extension,
    'docx'
  );
  // Anything else off the allowlist is rejected.
  for (const [mime, file] of [
    ['application/octet-stream', 'x.cpl'],
    ['application/octet-stream', 'x.msc'],
    ['application/java-archive', 'x.jar'],
    ['application/octet-stream', 'x.py'],
    ['application/x-msdownload', 'x.exe'],
    ['application/octet-stream', 'noext'],
  ]) {
    assert.throws(() => requiredAttachmentFile(`data:${mime};base64,aGk=`, file), TypeError, `${mime} ${file}`);
  }
  assert.throws(() => requiredAttachmentFile('http://x/', 'a.txt'), TypeError);
});

test('submit options accept the renderer retryFailedTurn field at the IPC boundary', () => {
  // Conversation.tsx resubmits failed turns (and model-switch continuation)
  // with `retryFailedTurn: true`; the allowlist must pass it through.
  assert.doesNotThrow(() => requiredSubmitOptions({ retryFailedTurn: true }));
  assert.doesNotThrow(() => requiredSubmitOptions({ retryFailedTurn: false }));
  assert.deepEqual(requiredSubmitOptions({ id: 'abc', retryFailedTurn: true }), {
    id: 'abc',
    retryFailedTurn: true,
  });
  assert.throws(() => requiredSubmitOptions({ retryFailedTurn: 'yes' }), /submit retryFailedTurn is invalid/);
  assert.throws(() => requiredSubmitOptions({ retryFailedTurn: 1 }), /submit retryFailedTurn is invalid/);
  // Unknown fields are still rejected.
  assert.throws(() => requiredSubmitOptions({ retryFailedTurns: true }), TypeError);
  assert.throws(() => requiredSubmitOptions({ device: 'studio' }), TypeError);
});

test('a model route selection carries contextTokens only as a positive integer', () => {
  const base = { provider: 'openai', model: 'gpt-test', contextPercent: 70 };
  assert.deepEqual(requiredModelSelection({ ...base, contextTokens: 640000 }), { ...base, contextTokens: 640000 });
  for (const bad of [0, -1, 1.5, '640000', Number.NaN]) {
    assert.throws(
      () => requiredModelSelection({ ...base, contextTokens: bad }),
      /contextTokens must be a positive integer/
    );
  }
});
