import assert from 'node:assert/strict';
import test from 'node:test';
import { _composeShellFailure, _exitClassDiagnostic } from './bash-tool.mjs';

test('missing commands retain their error without additional dependency guidance', () => {
    const stderr = 'sh: missing-runtime: command not found';
    const diagnostic = _exitClassDiagnostic(127, stderr);
    assert.equal(diagnostic, '');
    assert.equal(
        _composeShellFailure(`[exit code: 127]${diagnostic}`, '', '', stderr),
        `[exit code: 127]\n\n${stderr}`,
    );
});
