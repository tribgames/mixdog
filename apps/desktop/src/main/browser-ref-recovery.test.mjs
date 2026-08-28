import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBrowserRefSet,
  isBrowserStaleRefError,
  recoverBrowserRef,
} from './browser-ref-recovery.ts';

function payload(snapshotId, elements, url = 'https://example.test/app') {
  return {
    snapshotId,
    url,
    title: 'Example',
    scrollY: 0,
    scrollHeight: 900,
    viewportWidth: 1280,
    viewportHeight: 900,
    elements,
    totalElements: elements.length,
    scanned: elements.length,
    scanCapped: false,
    crossOriginFrames: 0,
    headings: [],
    text: '',
    query: '',
  };
}

test('browser ref recovery accepts one exact semantic match on the same page', () => {
  const source = createBrowserRefSet(payload('p1-s2', [
    { ref: 'p1-s2-e1', role: 'button', name: 'Continue', tag: 'ax' },
  ])).refs.get('p1-s2-e1');
  const fresh = createBrowserRefSet(payload('p1-s3', [
    { ref: 'p1-s3-e1', role: 'link', name: 'Help', tag: 'ax', href: 'https://example.test/help' },
    { ref: 'p1-s3-e2', role: 'button', name: 'Continue', tag: 'ax', states: ['focused'] },
  ]));

  assert.deepEqual(recoverBrowserRef(source, fresh), { ref: 'p1-s3-e2' });
});

test('browser ref recovery stops on ambiguity, navigation, or missing identity', () => {
  const sourceSet = createBrowserRefSet(payload('p2-s4', [
    { ref: 'p2-s4-e1', role: 'button', name: 'Delete', tag: 'ax' },
    { ref: 'p2-s4-e2', role: 'textbox', name: '', tag: 'ax' },
  ]));
  const ambiguous = createBrowserRefSet(payload('p2-s5', [
    { ref: 'p2-s5-e1', role: 'button', name: 'Delete', tag: 'ax' },
    { ref: 'p2-s5-e2', role: 'button', name: 'Delete', tag: 'ax' },
  ]));
  assert.match(
    recoverBrowserRef(sourceSet.refs.get('p2-s4-e1'), ambiguous).reason,
    /ambiguous/,
  );
  assert.match(
    recoverBrowserRef(
      sourceSet.refs.get('p2-s4-e1'),
      createBrowserRefSet(payload('p2-s5', [], 'https://example.test/other')),
    ).reason,
    /page or URL changed/,
  );
  assert.match(
    recoverBrowserRef(sourceSet.refs.get('p2-s4-e2'), ambiguous).reason,
    /no stable semantic name/,
  );
});

test('browser stale-ref classification excludes ordinary action failures', () => {
  assert.equal(isBrowserStaleRefError(new Error('Node with given id not found')), true);
  assert.equal(isBrowserStaleRefError(new Error('ref p1-s1-e1 is detached')), true);
  assert.equal(isBrowserStaleRefError(new Error('element is disabled')), false);
  assert.equal(isBrowserStaleRefError(new Error('navigation timed out')), false);
});
