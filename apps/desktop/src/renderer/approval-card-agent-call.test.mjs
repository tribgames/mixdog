import assert from 'node:assert/strict';
import test from 'node:test';

const { approvalCardModel } = await import('./ApprovalCard.tsx');
const { desktopToolActivityItemPresentation } = await import('./transcript-tool-model.ts');

// An ACP agent's permission request (mixdog-acp turn.rs): the call's input plus its title, the title as the reason.
// Both Antigravity presets name their own tools `antigravity_<kind>`; this one is the CLI's.
const agentCall = (kind, input, title) => ({
  id: 'appr_1',
  kind: 'approval',
  name: `antigravity_${kind}`,
  args: { ...input, title },
  cwd: 'C:/work',
  reason: title,
  agent: { id: 'antigravity-cli', label: 'Antigravity' },
  untitled: false,
  remember: ['session'],
});

test("an external agent's call says its title once and shows only what the title does not", () => {
  const titled = approvalCardModel(agentCall('read', {}, 'Read package.json'));
  assert.equal(titled.text, 'Read package.json');
  assert.equal(titled.detail, '');
  // The card's service is the agent, by its one name; the tool name stays the call's own.
  assert.equal(titled.agentLabel, 'Antigravity');
  assert.equal(titled.callName, 'antigravity_read');

  const command = approvalCardModel(agentCall('execute', { command: 'npm test' }, 'Run the tests'));
  assert.equal(command.text, 'Run the tests');
  assert.equal(command.detail, 'npm test');

  const other = approvalCardModel(agentCall('other', { target: 'staging' }, 'Deploy'));
  assert.equal(other.detail, JSON.stringify({ target: 'staging' }, null, 2));
});

test("a result that arrived after its call closed reads as that call's result", () => {
  // mixdog-acp rows.rs `late_arguments`: the call's own arguments and `resultOf`, the earlier call's id.
  const call = { kind: 'tool', id: 'call_2', name: 'antigravity_execute', result: 'woke', status: 'completed' };
  const earlier = desktopToolActivityItemPresentation({
    ...call,
    id: 'call_1',
    args: { command: 'npm test', title: 'Run tests' },
  });
  const late = desktopToolActivityItemPresentation({
    ...call,
    args: { command: 'npm test', title: 'Run tests', resultOf: 'call_1' },
  });
  assert.equal(late.verb, `Result of ${earlier.verb}`);
  assert.equal(late.subject, earlier.subject);
  assert.equal(late.outputText, 'woke');
  assert.deepEqual(late.fields, earlier.fields, 'the earlier call id is not shown as a field');
});
