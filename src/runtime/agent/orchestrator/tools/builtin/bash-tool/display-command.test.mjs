import '../../lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// Only execution is scripted: the real invocation plan builds the PowerShell
// wrapper (UTF-8 prefix + filter-tee rewrite) around a piped command.
let invocation = null;
mock.module('../../shell-command.mjs', {
  namedExports: {
    execShellCommand: async (input) => {
      invocation = input;
      return { stdout: '', stderr: '', exitCode: 0, signal: null };
    },
    stripAnsi: (text) => text,
  },
});
mock.module('./command-preflight.mjs', {
  namedExports: {
    prepareShellCommand: ({ command }) => ({
      command,
      analysisCommand: command,
      resolvedSpec: { shell: 'powershell.exe', shellArg: '-Command', shellArgs: [], shellType: 'powershell' },
    }),
  },
});

const { executeBashTool } = await import('../bash-tool.mjs');

test('a piped PowerShell command runs wrapped but reports the original command for job labels', {
  skip: process.platform !== 'win32',
}, async () => {
  const original = 'npm test 2>&1 | Select-String fail';
  await executeBashTool({ command: original, background: true }, process.cwd());
  assert.match(invocation.command, /__mixdogProducerExit/, 'the executed text carries the wrapper');
  assert.equal(invocation.displayCommand, original);
});
