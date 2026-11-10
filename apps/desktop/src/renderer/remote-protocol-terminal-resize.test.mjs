// Every kind of size value a page can pass to `termResize` becomes the size Node gave it (apps/mobile/fixtures/terminal-resize/golden.json,
// recorded through Node's real remote method and TerminalManager.resize): a claim that Node released is a release (0 x 0) here, any other
// size is the one Node's manager announced or gave the PTY, so the core never sees a size its notification cannot hold.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { terminalResizeRequest } from '../shared/terminal-protocol.ts';

const golden = JSON.parse(readFileSync(new URL('../../../mobile/fixtures/terminal-resize/golden.json', import.meta.url), 'utf8'));
const valueOf = (name) => {
  const input = golden.values.find((value) => value.name === name).value;
  return input?.absent ? undefined : input;
};

test("termResize sends the size Node's manager took for every recorded value, a release where Node released", () => {
  assert.equal(golden.cases.length, golden.values.length * 4);
  for (const { claim, axis, input, owners, sizes } of golden.cases) {
    const [cols, rows] = axis === 'cols' ? [valueOf(input), 24] : [100, valueOf(input)];
    const sent = terminalResizeRequest('term_resize', cols, rows, claim);
    const what = `${claim ? 'claim' : 'resize'} ${axis} ${input}`;
    if (claim) {
      assert.equal(owners.length, 1, what);
      const [{ cols: c, rows: r, owner }] = owners;
      assert.deepEqual(sent, owner === '' ? { tabId: 'term_resize', cols: 0, rows: 0, claim: true } : { tabId: 'term_resize', cols: c, rows: r, claim: true }, what);
    } else {
      assert.deepEqual(sent, { tabId: 'term_resize', ...sizes[0] }, what);
    }
  }
});
