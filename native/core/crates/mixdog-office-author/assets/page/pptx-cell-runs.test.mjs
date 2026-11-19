// `linkedCellRuns` of pptx-html-measure.js against a DOM. jsdom has no layout and no `innerText`, so each fixture
// passes the text the browser shows for the cell (`full`) the way the measure does.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const source = readFileSync(new URL('./pptx-html-measure.js', import.meta.url), 'utf8');
const extract = new Function(`${source}\nreturn linkedCellRuns;`)();

// Whatever the runs are, they rebuild the cell's text exactly: no text lost, none added.
function linkedCellRuns(td, full) {
  const runs = extract(td, full);
  if (runs.length) assert.equal(runs.map((run) => run.text).join(''), full);
  return runs;
}

function cell(html) {
  const { document } = new JSDOM(`<table><tr><td>${html}</td></tr></table>`, { url: 'https://base.test/' }).window;
  return document.querySelector('td');
}

test('line breaks and hidden text come out as innerText has them, with links on the parts they cover', () => {
  const td = cell(
    '<a href="https://a.test/">Alpha</a><br><a href="/b">Beta</a><span style="display:none">Hidden</span> and <span style="visibility:hidden">Ghost</span>plain'
  );
  const runs = linkedCellRuns(td, 'Alpha\nBeta and plain');
  assert.deepEqual(runs, [
    { text: 'Alpha', href: 'https://a.test/' },
    { text: '\n' },
    { text: 'Beta', href: 'https://base.test/b' },
    { text: ' and plain' },
  ]);
  assert.equal(runs.map((run) => run.text).join(''), 'Alpha\nBeta and plain');
});

test('two links keep their own targets, a rejected scheme and plain text carry none', () => {
  const td = cell('<a href="https://one.test/">One</a> <a href="javascript:alert(1)">Bad</a> <a href="mailto:x@y.test">Two</a> tail');
  assert.deepEqual(linkedCellRuns(td, 'One Bad Two tail'), [
    { text: 'One', href: 'https://one.test/' },
    { text: ' Bad ' },
    { text: 'Two', href: 'mailto:x@y.test' },
    { text: ' tail' },
  ]);
});

test('a non-breaking space stays in the label and keeps the link', () => {
  const td = cell('<a href="https://a.test/">Read&nbsp;more</a> now');
  assert.deepEqual(linkedCellRuns(td, 'Read\u00a0more now'), [
    { text: 'Read\u00a0more', href: 'https://a.test/' },
    { text: ' now' },
  ]);
  const edge = cell('<a href="https://a.test/">&nbsp;Go</a>');
  assert.deepEqual(linkedCellRuns(edge, 'Go'), [{ text: 'Go', href: 'https://a.test/' }]);
});

test('two links with the same label keep their own targets when each label starts with a non-breaking space', () => {
  const td = cell('<a href="https://one.test/">&nbsp;Go</a> / <a href="https://two.test/">&nbsp;Go</a>');
  assert.deepEqual(linkedCellRuns(td, 'Go / \u00a0Go'), [
    { text: 'Go', href: 'https://one.test/' },
    { text: ' / ' },
    { text: '\u00a0Go', href: 'https://two.test/' },
  ]);
});

test('a character that folds to more than one never moves a target onto another label', () => {
  const td = cell('\u0130: <a href="https://one.test/">1</a><a href="https://two.test/">2</a>');
  assert.deepEqual(linkedCellRuns(td, '\u0130: 12'), []);
  // The same cell without it keeps both links
  const plain = cell('I: <a href="https://one.test/">1</a><a href="https://two.test/">2</a>');
  assert.deepEqual(linkedCellRuns(plain, 'I: 12'), [
    { text: 'I: ' },
    { text: '1', href: 'https://one.test/' },
    { text: '2', href: 'https://two.test/' },
  ]);
});

test('a space inside one link stays in it, shown case is kept, and text not found leaves the cell plain', () => {
  const td = cell('<a href="https://a.test/">Two <b>words</b></a>');
  assert.deepEqual(linkedCellRuns(td, 'Two words'), [{ text: 'Two words', href: 'https://a.test/' }]);
  // text-transform shows in `full`: the runs take the shown text, not the source's
  assert.deepEqual(linkedCellRuns(td, 'TWO WORDS'), [{ text: 'TWO WORDS', href: 'https://a.test/' }]);
  assert.deepEqual(linkedCellRuns(td, 'something else'), []);
});
