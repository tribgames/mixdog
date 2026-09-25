import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// The anchor text is read inside a script injected through executeJavaScript,
// so the regex travels through a TypeScript template literal first. Evaluate
// that literal the way the source does and run the regex it produces.
test('switch probe anchor text strips whitespace, not the letter s', async () => {
  const source = await readFile(new URL('./jitter-probe-switch.ts', import.meta.url), 'utf8');
  const match = /text: \(entry\.row\.textContent \|\| ''\)\.replace\((\/[^/]*\/g), ''\)/.exec(source);
  assert.ok(match, 'anchor text normalization is present in the injected script');
  const injected = Function(`return \`${match[1]}\`;`)();
  const regex = Function(`return ${injected};`)();
  assert.equal('Switch A\ttranscript\nrow s'.replace(regex, ''), 'SwitchAtranscriptrows');
});
