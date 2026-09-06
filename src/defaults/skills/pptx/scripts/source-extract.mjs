#!/usr/bin/env node
// Supplied material as quotable blocks with locators, so a deck's facts line
// can cite where each figure came from (pptx skill §2 "Ground"): [p3] for a
// page, [Sheet1!B4] for a cell, [slide 4] for a slide, [line 42] for text.
// Office files (pdf, docx, xlsx, pptx) are read through the office tool in a
// portable session that is closed without saving; anything else is read as
// UTF-8 text. Output is bounded by --chars (default 4000) and every block is
// cut at BLOCK_CHARS, so a large source never floods the context.
//   node "${MIXDOG_SKILL_DIR}/scripts/source-extract.mjs" <file> [--chars 4000]
import { access, readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const DEFAULT_CHARS = 4000;
export const BLOCK_CHARS = 600;
export const OFFICE_EXTENSIONS = Object.freeze(['.pdf', '.docx', '.xlsx', '.pptx']);

// Plain text: one block per non-empty line, numbered from 1 so a fact can cite [line 42].
export function fromPlainText(text, limit = DEFAULT_CHARS) {
  const out = [];
  const lines = String(text ?? '').split('\n');
  let used = 0;
  for (let index = 0; index < lines.length && used < limit; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    out.push(`[line ${index + 1}] ${line}`);
    used += line.length;
  }
  return out;
}

// Page chrome — slide number, footer, and date placeholders — is not source material.
const isPageChrome = (shape) => Boolean(shape?.placeholder) && /slide ?number|footer|date/i.test(String(shape?.name || ''));

// A snapshot document — pages (PDF), slides (PPTX), blocks or paragraphs (DOCX),
// sheets (XLSX) — as blocks prefixed with the locator the facts line quotes.
export function fromDocument(document, limit = DEFAULT_CHARS) {
  const out = [];
  let used = 0;
  const push = (locator, text) => {
    const body = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!body || used >= limit) return;
    out.push(`[${locator}] ${body.slice(0, BLOCK_CHARS)}`);
    used += Math.min(body.length, BLOCK_CHARS);
  };
  for (const page of document?.pages || []) push(`p${page.number ?? page.index}`, page.text);
  for (const slide of document?.slides || []) {
    for (const shape of slide.shapes || []) {
      if (isPageChrome(shape)) continue;
      push(`slide ${slide.number ?? slide.index}`, shape.text);
    }
  }
  for (const block of document?.blocks || document?.paragraphs || []) {
    push(block.page ? `p${block.page}` : `¶${block.index ?? out.length + 1}`, block.text);
  }
  for (const sheet of document?.sheets || []) {
    for (const cell of sheet.cells || []) push(`${sheet.name}!${cell.ref}`, cell.value ?? cell.formula);
  }
  return out;
}

async function defaultOffice() {
  const { executeOfficeTool } = await import('../../../../runtime/office/index.mjs');
  return async (args, cwd) => {
    const result = await executeOfficeTool(args, { cwd });
    const body = result?.content?.[0]?.text || '';
    if (result?.isError) throw new Error(body || 'office call failed');
    return JSON.parse(body);
  };
}

// Read one file into locator-prefixed blocks. `office` is an injectable office
// call `(args, cwd) => parsed result` for tests; the default drives the runtime.
export async function extractSource(target, { chars = DEFAULT_CHARS, cwd = process.cwd(), office = null } = {}) {
  const source = String(target ?? '').trim();
  if (!source) throw new Error('source-extract needs a file path');
  const limit = Number(chars);
  if (!Number.isFinite(limit) || limit <= 0) throw new Error(`--chars must be a positive number, got ${chars}`);
  const path = resolve(cwd, source);
  try {
    await access(path);
  } catch {
    throw new Error(`source file not found: ${path}`);
  }
  const extension = extname(path).toLowerCase();
  if (!OFFICE_EXTENSIONS.includes(extension)) {
    return { source, path, kind: 'text', blocks: fromPlainText(await readFile(path, 'utf8'), limit) };
  }
  const call = office || await defaultOffice();
  const opened = await call({ action: 'open', path, mode: 'portable', snapshotAfter: false }, cwd);
  try {
    const snapshot = await call({ action: 'snapshot', session: opened.session, limit: 200, maxChars: 100_000 }, cwd);
    return { source, path, kind: extension.slice(1), blocks: fromDocument(snapshot.document, limit) };
  } finally {
    await call({ action: 'close', session: opened.session, save: false }, cwd).catch(() => {});
  }
}

export function formatExtract({ source, blocks }) {
  return [
    `# ${source} — ${blocks.length} blocks (cite the bracketed locator in the brief's facts line)`,
    '',
    ...blocks,
    '',
    `# sources: ${source}`,
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { chars: { type: 'string' } } });
    if (positionals.length !== 1) {
      throw new Error('Usage: source-extract.mjs <file.pdf|docx|xlsx|pptx|md|txt> [--chars 4000]');
    }
    console.log(formatExtract(await extractSource(positionals[0], { chars: values.chars ?? DEFAULT_CHARS })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
