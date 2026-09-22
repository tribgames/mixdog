import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

// The jump itself lives inside EditorPane's Monaco-bound body, which only the
// slow browser lane can mount, so the contract is pinned across the two files
// that produce and consume a reveal request.
const navigation = readFileSync(new URL('./use-editor-navigation.ts', import.meta.url), 'utf8');
const pane = readFileSync(new URL('./EditorPane.lazy.tsx', import.meta.url), 'utf8');

test('a reveal request keys its jump on the requested line, not on the wall-clock nonce alone', () => {
  // Every reveal is stamped with Date.now(), so two jumps raised in the same
  // millisecond carry the SAME nonce. A nonce-only dependency then drops the
  // second line: the editor keeps the first one's cursor and scroll position.
  assert.match(navigation, /setFileReveal\(\{[^}]*nonce: Date\.now\(\)[^}]*\}\)/);
  const start = pane.indexOf('if (!reveal || !load) return;');
  assert.ok(start > 0, 'the reveal effect must still guard on the request and the loaded file');
  const effect = pane.slice(start);
  const end = effect.indexOf('}, [');
  assert.ok(end > 0, 'the reveal effect must still declare a dependency list');
  const body = effect.slice(0, end);
  const dependencies = effect.slice(end, effect.indexOf(']);') + 3);
  assert.match(body, /reveal\.line/);
  assert.match(dependencies, /reveal\?\.line/);
  // The original keys stay: a repeat jump to the same line still re-runs, and
  // the reveal belongs to this pane's own file.
  assert.match(dependencies, /reveal\?\.nonce/);
  assert.match(dependencies, /relPath/);
});
