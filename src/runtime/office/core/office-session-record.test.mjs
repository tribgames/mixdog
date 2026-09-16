import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyOfficeDesignState, microsoftOfficeOpenFields, officeSessionId } from './office-core.mjs';
import { csvCell } from './office-actions-read.mjs';

test('office session ids are stable in shape and unique', () => {
  const first = officeSessionId();
  const second = officeSessionId();
  assert.match(first, /^office_[0-9a-f]{16}$/);
  assert.notEqual(first, second);
});

test('design-state defaults keep slide plans except for portable create', () => {
  assert.deepEqual(emptyOfficeDesignState(), {
    renderedVersion: null,
    semanticCount: 0,
    requiresVisualReview: false,
    slidePlans: [],
    compositions: [],
  });
  assert.equal('slidePlans' in emptyOfficeDesignState({ includeSlidePlans: false }), false);
  assert.equal(emptyOfficeDesignState({ requiresVisualReview: true }).requiresVisualReview, true);
});

test('COM open fields copy identity without inventing a mode', () => {
  assert.deepEqual(
    microsoftOfficeOpenFields({
      mode: 'background',
      ownership: 'owned',
      visible: false,
      appPid: 12,
      windowHwnd: 34,
      foregroundActivated: true,
      backgroundIsolation: { desktop: 'mixdog' },
      documentId: 'doc-1',
    }),
    {
      mode: 'background',
      ownership: 'owned',
      visible: false,
      appPid: 12,
      windowHwnd: 34,
      foregroundActivated: true,
      backgroundIsolation: { desktop: 'mixdog' },
      documentId: 'doc-1',
    }
  );
  assert.equal(microsoftOfficeOpenFields({}).foregroundActivated, false);
  assert.equal(microsoftOfficeOpenFields({}).backgroundIsolation, null);
});

test('PDF table CSV quoting follows RFC 4180', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
});
