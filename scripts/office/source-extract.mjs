#!/usr/bin/env node
// Turn supplied material into quotable text with locators, so a deck's facts line can cite where each
// figure came from (pptx skill §2 "Ground"). This is the front end the grounded generators win on: the
// deck is only as good as the sheet of facts it is built from.
//   node scripts/office/source-extract.mjs <file.pdf|docx|xlsx|md|txt> [--chars 4000]
// Prints blocks prefixed with the locator to cite: [p3] for pages, [Sheet1!A1] for cells, [line 42] for text.
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { executeOfficeTool } from '../../src/runtime/office/index.mjs';

const value = (result) => JSON.parse(result.content[0].text);
const OFFICE = new Set(['.pdf', '.docx', '.xlsx', '.pptx']);

function fromPlainText(text, limit) {
  const lines = text.split('\n');
  const out = [];
  let used = 0;
  for (let index = 0; index < lines.length && used < limit; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    out.push(`[line ${index + 1}] ${line}`);
    used += line.length;
  }
  return out;
}

function fromDocument(document, limit) {
  const out = [];
  let used = 0;
  const push = (locator, text) => {
    const body = String(text || '').replace(/\s+/g, ' ').trim();
    if (!body || used >= limit) return;
    out.push(`[${locator}] ${body.slice(0, 600)}`);
    used += Math.min(body.length, 600);
  };
  for (const page of document?.pages || []) push(`p${page.number ?? page.index}`, page.text);
  for (const slide of document?.slides || []) {
    for (const shape of slide.shapes || []) push(`slide ${slide.index}`, shape.text);
  }
  for (const block of document?.blocks || document?.paragraphs || []) {
    push(block.page ? `p${block.page}` : `¶${block.index ?? out.length + 1}`, block.text);
  }
  for (const sheet of document?.sheets || []) {
    for (const cell of sheet.cells || []) push(`${sheet.name}!${cell.ref}`, cell.value ?? cell.formula);
  }
  return out;
}

const [target, ...rest] = process.argv.slice(2);
if (!target) {
  console.error('usage: node scripts/office/source-extract.mjs <file> [--chars 4000]');
  process.exit(1);
}
const charsAt = rest.indexOf('--chars');
const limit = charsAt >= 0 ? Number(rest[charsAt + 1]) || 4000 : 4000;
const path = resolve(target);
const extension = extname(path).toLowerCase();

let blocks = [];
if (OFFICE.has(extension)) {
  const opened = value(await executeOfficeTool({ action: 'open', path }, { cwd: resolve('.') }));
  const snap = value(await executeOfficeTool({ action: 'snapshot', session: opened.session, limit: 200, maxChars: 100_000 }, { cwd: resolve('.') }));
  blocks = fromDocument(snap.document, limit);
  await executeOfficeTool({ action: 'close', session: opened.session, save: false }, { cwd: resolve('.') }).catch(() => {});
} else {
  blocks = fromPlainText(await readFile(path, 'utf8'), limit);
}

console.log(`# ${target} — ${blocks.length} blocks (cite the bracketed locator in the brief's facts line)\n`);
console.log(blocks.join('\n'));
console.log(`\n# sources: ${target}`);
