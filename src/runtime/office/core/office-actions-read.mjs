import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractPdfImages, extractPdfTextLayout, findPdfText, inferPdfTables } from '../pdf/pdf-analysis.mjs';
import {
  findByDocumentPath,
  fullPath,
  queryObject,
  snapshot,
  snapshotSelectionForTarget,
} from './office-sessions.mjs';

/** RFC 4180 quoting so a table cell that contains a comma or quote round-trips. */
export function csvCell(text) {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function getOfficeElement(session, args) {
  const target = String(args.target || '').trim();
  if (!target) throw new Error('get requires target');
  const selection = snapshotSelectionForTarget(session.format, target);
  // One leaf is read as one item; a container (a sheet, a slide, a table)
  // is read with its own contents, because asking for the element and
  // getting one of its twelve cells back under truncated:true answers a
  // question the caller did not ask.
  const leafTarget = /\/(?:cell|run|note|comment|comment-thread|revision|footnote|endnote|content-control)\[[^\]]+]$/i.test(target);
  const current = await snapshot(session, {
    ...args,
    ...selection,
    target,
    ...(leafTarget ? { limit: 1 } : {}),
    maxChars: 100_000,
  });
  const element = findByDocumentPath(current.document, target);
  if (!element) throw new Error(`Document element not found: ${target}`);
  const pagination = current.document?.pagination;
  return {
    session: session.id,
    target,
    element,
    // A container too large for one read says how to continue rather than
    // leaving truncated:true as the whole answer.
    ...(pagination?.hasMore ? { pagination } : {}),
  };
}

async function queryPdfLayout(session, args, signal) {
  const needle = String(args.query || '').trim();
  const layout = await extractPdfTextLayout(session.target, {
    pages: args.pages,
    maxItems: needle ? 20_000 : (args.limit || 10_000),
    shapes: !needle,
    signal,
  });
  // A search answers with the boxes alone: the caller wants where a
  // phrase sits, not every run on the page.
  return needle
    ? {
      session: session.id,
      queryKind: 'pdf-layout',
      pageCount: layout.pageCount,
      ...findPdfText(layout, needle, { limit: args.limit || 200 }),
      pages: layout.pages.map(({ page, width, height }) => ({ page, width, height })),
    }
    : { session: session.id, queryKind: 'pdf-layout', ...layout };
}

async function queryPdfTables(session, args, cwd, signal) {
  const layout = await extractPdfTextLayout(session.target, {
    pages: args.pages,
    maxItems: args.limit || 10_000,
    signal,
  });
  const inferred = inferPdfTables(layout);
  if (args.output) {
    // One CSV per table, UTF-8, RFC 4180 quoting: the shape the xlsx and tabular sessions read back.
    const directory = fullPath(args.output, cwd);
    await mkdir(directory, { recursive: true });
    const counters = new Map();
    for (const table of inferred.tables) {
      const ordinal = (counters.get(table.page) || 0) + 1;
      counters.set(table.page, ordinal);
      const file = join(directory, `page-${table.page}-table-${ordinal}.csv`);
      await writeFile(file, `${table.rows.map((row) => row.map((cell) => csvCell(String(cell ?? ''))).join(',')).join('\r\n')}\r\n`, 'utf8');
      table.path = file;
    }
    inferred.output = directory;
  }
  return { session: session.id, queryKind: 'pdf-tables', ...inferred };
}

async function queryPdfImages(session, args, cwd, signal) {
  const extracted = await extractPdfImages(session.target, { pages: args.pages, signal });
  if (args.output) {
    // Files instead of inline pictures: a directory of PNGs the caller can reuse.
    const directory = fullPath(args.output, cwd);
    await mkdir(directory, { recursive: true });
    const written = [];
    for (const image of extracted._images) {
      const file = join(directory, `page-${image.page}-image-${image.index}.png`);
      await writeFile(file, Buffer.from(image.data, 'base64'));
      written.push(file);
    }
    extracted.images = extracted.images.map((image, index) => ({ ...image, path: written[index] }));
    extracted.output = directory;
    delete extracted._images;
  }
  return { session: session.id, queryKind: 'pdf-images', ...extracted };
}

export async function queryOfficeDocument(session, args, cwd, signal) {
  const queryKind = String(args.queryKind || 'text').toLowerCase();
  if (queryKind === 'text') {
    const needle = String(args.query || '').trim().toLowerCase();
    if (!needle) throw new Error('query requires non-empty query text');
    const current = await snapshot(session, { ...args, maxChars: 100_000 }, { full: true });
    return {
      session: session.id,
      query: args.query,
      matches: queryObject(current.document, needle),
    };
  }
  if (session.format !== 'pdf') throw new Error(`${queryKind} query is supported for PDF sessions only`);
  if (queryKind === 'pdf-layout') return queryPdfLayout(session, args, signal);
  if (queryKind === 'pdf-tables') return queryPdfTables(session, args, cwd, signal);
  if (queryKind === 'pdf-images') return queryPdfImages(session, args, cwd, signal);
  throw new Error(`Unsupported Office queryKind: ${queryKind}`);
}
