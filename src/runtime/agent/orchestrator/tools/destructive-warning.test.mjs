import './lib/isolated-test-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getDestructiveCommandWarning, stripQuotedAndHeredoc } from './destructive-warning.mjs';
import { evaluateExecPolicy } from './bash-policy-scan.mjs';
import { _isBenignSearchExitOne } from './builtin/bash-tool/benign-exit.mjs';

test('# inside a word or URL is not a comment: the command after it is still seen', () => {
  for (const command of [
    'a#b; rm -rf /',
    'echo http://x/#y && rm -rf ~',
    'echo $#; rm -rf /',
    'echo ${#v}; rm -rf /',
  ]) {
    assert.match(stripQuotedAndHeredoc(command), /rm -rf/, command);
    assert.equal(getDestructiveCommandWarning(command), 'may recursively force-remove files', command);
    assert.equal(evaluateExecPolicy(command).decision, 'deny', command);
  }
  assert.equal(getDestructiveCommandWarning('a#b; DROP TABLE t'), 'may drop or truncate database objects');
});

test('a real comment hides its text; the next line stays live', () => {
  for (const command of [
    'echo hi # rm -rf /',
    'echo hi # a; rm -rf /',
    'echo hi;# rm -rf /',
    "echo it's # rm -rf /",
    'echo hi <# rm -rf / #>',
  ]) {
    assert.equal(getDestructiveCommandWarning(command), null, command);
    assert.equal(evaluateExecPolicy(command).decision, 'allow', command);
  }
  assert.equal(getDestructiveCommandWarning('echo hi # DROP TABLE t'), null);
  assert.equal(getDestructiveCommandWarning('echo x # c\nrm -rf /'), 'may recursively force-remove files');
  assert.equal(getDestructiveCommandWarning('echo hi <# c #>; rm -rf ~'), 'may recursively force-remove files');
  // An unterminated block comment is not a comment: leave it visible.
  assert.match(stripQuotedAndHeredoc('echo <# x; rm -rf /'), /rm -rf/);
});

test('quoted text and here-strings stay hidden; uncertain constructs stay visible', () => {
  for (const command of ['echo "rm -rf /"', "echo 'rm -rf /'", "x = @'\nrm -rf /\n'@", 'x = @"\nrm -rf /\n"@']) {
    assert.doesNotMatch(stripQuotedAndHeredoc(command), /rm -rf/, command);
    assert.equal(evaluateExecPolicy(command).decision, 'allow', command);
  }
  // Text after a heredoc opener on the same line is executable, not body.
  assert.equal(getDestructiveCommandWarning('cat <<EOF | rm -rf /\nx\nEOF'), 'may recursively force-remove files');
  assert.equal(evaluateExecPolicy('cat <<EOF | rm -rf /\nx\nEOF').decision, 'deny');
  // `<<<` is a here-string, not a heredoc: it must not swallow the next lines.
  assert.match(stripQuotedAndHeredoc('cat <<< foo; rm -rf /\nfoo'), /rm -rf/);
  // Escaped / unterminated quotes never pair across a destructive command.
  assert.match(stripQuotedAndHeredoc("echo \\'; rm -rf /; echo '"), /rm -rf/);
  assert.match(stripQuotedAndHeredoc("echo it's; rm -rf /"), /rm -rf/);
  assert.match(stripQuotedAndHeredoc('cat <<EOF; rm -rf /'), /rm -rf/);
  assert.equal(getDestructiveCommandWarning("echo it's; rm -rf /"), 'may recursively force-remove files');
  assert.equal(evaluateExecPolicy("echo \\'; rm -rf /; echo '").decision, 'deny');
});

test('benign search exit: comments end at newline and only start a word', () => {
  assert.equal(_isBenignSearchExitOne('grep x f # note', 1, null, ''), true);
  assert.equal(_isBenignSearchExitOne('grep x f;# note', 1, null, ''), true);
  assert.equal(_isBenignSearchExitOne('grep x f # note\nfalse', 1, null, ''), false);
  assert.equal(_isBenignSearchExitOne('false; echo a#b; grep x f', 1, null, ''), true);
  assert.equal(_isBenignSearchExitOne('grep x f; echo a#b', 1, null, ''), false);
});

test('git global pathspec options are skipped only as whole tokens', () => {
  for (const option of ['--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs']) {
    assert.equal(getDestructiveCommandWarning(`git ${option} reset --hard`), 'may discard uncommitted changes');
  }
  // A token that merely CONTAINS an option name is not that global option: it
  // occupies the subcommand position, so nothing after it is classified.
  for (const token of ['--literal-pathspecs-x', 'x--glob-pathspecs', 'x--noglob-pathspecs-y', 'x--icase-pathspecs']) {
    assert.equal(getDestructiveCommandWarning(`git ${token} reset --hard`), null, token);
  }
});
