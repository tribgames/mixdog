import assert from 'node:assert/strict';
import test from 'node:test';

import { mismatches, parseTree, selectionFeatures, widening } from './core-align.mjs';

// cargo tree's own indented tree (`-f "{p} {f}"`): four columns a level, headings for build- and dev-dependencies
const WHOLE = [
  'mixdog-protocol v1.5.0 (D:\\a\\core\\crates\\mixdog-protocol) codegen,default',
  '├── serde v1.0.0 derive,std',
  '│   └── serde_derive v1.0.0 (proc-macro) default',
  '│       └── syn v2.0.1 full,parsing',
  '[build-dependencies]',
  '└── syn v2.0.1 full,parsing (*)',
  '',
  'mixdog-rt v1.5.0 (/w/crates/mixdog-rt) test-support,virtual-clock',
  '├── tracing-log v0.2.0 default,log-tracer,std',
  '└── syn v2.0.1 parsing',
  '[dev-dependencies]',
  '└── mixdog-protocol v1.5.0 (/w/crates/mixdog-protocol) codegen,default (*)',
  '',
].join('\r\n');

test('a tree tells a crate built for the host (build dependency, proc macro, below either) from one built for the target', () => {
  const tree = parseTree(WHOLE);
  assert.deepEqual([...tree.get('target syn v2.0.1')], ['parsing']);
  assert.deepEqual([...tree.get('host syn v2.0.1')], ['full,parsing']);
  assert.ok(tree.has('host serde_derive v1.0.0') && tree.has('target serde v1.0.0') && !tree.has('host serde v1.0.0'));
  // a host build of a crate is not a target build with the same features: the check compares each role apart
  const hostOnly = parseTree('mixdog-rt v1.5.0 (/x) test-support,virtual-clock\n└── syn v2.0.1 full,parsing\n');
  assert.match(mismatches(tree, hostOnly).join('\n'), /^target syn v2\.0\.1: the selection resolves \[full,parsing\]/);
});

test('a selection names for each crate it selects the features the whole build gives it, and the check fails on any other resolution', () => {
  const whole = parseTree(WHOLE);
  assert.deepEqual(selectionFeatures(whole, ['mixdog-protocol'], ['mixdog-protocol/x']), [
    'mixdog-protocol/codegen',
    'mixdog-protocol/default',
    'mixdog-protocol/x',
  ]);
  assert.deepEqual(
    mismatches(whole, parseTree('mixdog-rt v1.5.0 (/x) virtual-clock,test-support\n└── syn v2.0.1 parsing\n')),
    []
  );
  const found = mismatches(
    whole,
    parseTree('mixdog-protocol v1.5.0 (/x) default\n└── tracing-log v0.2.0 log-tracer,std\n')
  );
  assert.equal(found.length, 2);
  assert.match(
    found[0],
    /^target mixdog-protocol v1\.5\.0: the selection resolves \[default\], the whole \[codegen,default\]/
  );
  assert.match(found[1], /^target tracing-log v0\.2\.0/);
  assert.equal(mismatches(whole, parseTree('extra v1.0.0 \n')).length, 1);
  // a partial build adds the workspace crates it resolved otherwise, never a third-party one
  const partial = parseTree(
    'mixdog-protocol v1.5.0 (/x) default\nmixdog-rt v1.5.0 (/x) test-support,virtual-clock\n└── tracing-log v0.2.0 std\n'
  );
  assert.deepEqual(widening(whole, partial, ['mixdog-protocol', 'mixdog-rt']), ['mixdog-protocol']);
});
