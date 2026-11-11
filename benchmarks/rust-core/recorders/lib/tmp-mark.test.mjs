// markMachineText replaces a machine root only where it ends at a path boundary.
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import test from 'node:test';
import { markMachineText } from './tmp-mark.mjs';

const home = homedir();
const mark = (text) => markMachineText(text).text;

test('a root that is only the start of a longer name is left alone', () => {
  assert.equal(mark(`${home}st/ordinary.txt`), `${home}st/ordinary.txt`);
  assert.equal(mark(`${home}st\\ordinary.txt`), `${home}st\\ordinary.txt`);
  assert.equal(markMachineText(`${home}st/x`).count, undefined);
  assert.deepEqual(markMachineText(`${home}st/x`).rewrites, {});
});

test('a root followed by each separator spelling is replaced and the separator kept', () => {
  const forward = home.replaceAll('\\', '/');
  assert.equal(mark(`${home}\\a`), '<HOME>\\a');
  assert.equal(mark(`${home}/a`), '<HOME>/a');
  assert.equal(mark(`${forward}/a`), '<HOME>/a');
  assert.equal(mark(`${home.replaceAll('\\', '\\\\')}\\\\a`), '<HOME>\\\\a');
  assert.equal(mark(`${encodeURIComponent(home)}%5Ca`), '<HOME>%5Ca');
  assert.equal(mark(`${encodeURIComponent(home)}%2fa`), '<HOME>%2fa');
});

test('a root at the end of a string, before a quote, and repeated is replaced', () => {
  assert.equal(mark(home), '<HOME>');
  assert.equal(mark(`"${home}"`), '"<HOME>"');
  const r = markMachineText(`${home}st ${home}\\a ${home}`);
  assert.equal(r.text, `${home}st <HOME>\\a <HOME>`);
  assert.deepEqual(r.rewrites, { '<HOME>': { originalLength: home.length, count: 2 } });
});