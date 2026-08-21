import assert from 'node:assert/strict';
import test from 'node:test';
import { _isGitMutationTool, _isMutationTool } from '../../session/loop/tool-classify.mjs';
import { gitCommandMutates } from './git-command-policy.mjs';

test('git mutation policy is shared by orchestration and evidence projection', () => {
    for (const command of ['git status', 'git log -5', 'git fsck --full', 'git clean -n', 'git config get user.name']) {
        assert.equal(gitCommandMutates({ command }), false, command);
        assert.equal(_isMutationTool('git', { command }), false, command);
        assert.equal(_isGitMutationTool('git', { command }), false, command);
    }
    for (const command of [
        'git add --all',
        'git commit -m test',
        'git prune --expire=now',
        'git reflog delete HEAD@{1}',
        'git fsck --lost-found',
        'git config --unset user.name',
        'git config unset user.name',
    ]) {
        assert.equal(gitCommandMutates({ command }), true, command);
        assert.equal(_isMutationTool('git', { command }), true, command);
        assert.equal(_isGitMutationTool('git', { command }), true, command);
    }
    assert.equal(gitCommandMutates({ command: 'git status && git clean -fd' }), true);
    const stage = { diff_id: 'diff_test', change_ids: ['chg_test'] };
    assert.equal(_isMutationTool('git_stage', stage), true);
    assert.equal(_isGitMutationTool('git_stage', stage), true);
    assert.equal(_isMutationTool('apply_patch', {}), true);
});
