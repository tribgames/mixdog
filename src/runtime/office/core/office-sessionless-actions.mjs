/**
 * office-sessionless-actions.mjs — the Office Use actions that answer without
 * a document session: capability/environment reports (detect, describe with no
 * session), the transaction registry (transactions, recover), the standalone
 * PDF security pass (secure), authoring (author) and the session-opening
 * actions (open/attach/create).
 *
 * Every handled action returns a finished tool result; an unhandled action
 * returns null so the caller falls through to the session-bound dispatch.
 */
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { detectMicrosoftOffice } from '../com/com-adapter.mjs';
import { pdfOcrReadiness } from '../pdf/pdf-analysis.mjs';
import { describeOfficeCapabilities } from '../capabilities.mjs';
import { qpdfAvailable, securePdf } from '../pdf/pdf-security.mjs';
import { unicodeFontPath } from '../pdf/pdf-fonts.mjs';
import { inspectOfficeDesignLibrary } from '../design/library/design-library.mjs';
import { openCreateOrAttachOffice } from './office-actions-open.mjs';
import { authorPptx } from '../authoring/pptx-author-action.mjs';
import {
  FILE_KIND_TO_FORMAT,
  documentFormat,
  finalizeOfficeResult,
  normalizeOfficeFormat,
  sessions,
  toolResult,
} from './office-core.mjs';
import { fullPath, selectMode } from './office-sessions.mjs';
import { pendingOfficeTransactions, recoverOfficeTransaction } from './office-transactions.mjs';

async function detectAction(args, cwd, dataDir) {
  const office = await detectMicrosoftOffice({
    format: args.path ? documentFormat(args.path) : '',
    path: args.path ? fullPath(args.path, cwd) : '',
  });
  return toolResult({
    ok: true,
    microsoftOffice: office,
    portable: {
      ooxml: true,
      pdf: true,
      formats: Object.keys(FILE_KIND_TO_FORMAT),
      pdfSecurity: { available: await qpdfAvailable(), backend: 'qpdf' },
      pdfUnicodeFont: await unicodeFontPath(),
      pdfOcr: await pdfOcrReadiness(dataDir),
    },
    pendingTransactions: await pendingOfficeTransactions(dataDir),
    designLibrary: await inspectOfficeDesignLibrary({ dataDir }),
  });
}

async function secureAction(args, cwd, startedAt) {
  const input = fullPath(args.path, cwd);
  if (documentFormat(input) !== 'pdf') throw new Error('secure supports PDF files only');
  const output = fullPath(args.output, cwd);
  const mode = String(args.security || '').toLowerCase();
  if (!['encrypt', 'decrypt'].includes(mode)) throw new Error('secure requires security: encrypt or decrypt');
  await mkdir(dirname(output), { recursive: true });
  return toolResult(
    finalizeOfficeResult(
      await securePdf({
        input,
        output,
        mode,
        password: String(args.password || ''),
        ownerPassword: String(args.ownerPassword || ''),
      }),
      { action: 'secure', startedAt }
    )
  );
}

async function describeWithoutSession(args, cwd) {
  let format = '';
  if (args.path) format = documentFormat(args.path);
  else if (args.format) format = normalizeOfficeFormat(args.format);
  let backend = '';
  if (format && args.path) {
    const selected = await selectMode(args.mode, format, fullPath(args.path, cwd));
    backend = selected.backend;
  }
  return toolResult(
    describeOfficeCapabilities({
      format,
      backend: backend || String(args.backend || ''),
      target: args.target,
      operation: args.operation,
    })
  );
}

async function authorAction(args, cwd, dataDir, signal, startedAt) {
  const authored = await authorPptx(args, { cwd, dataDir, signal });
  const images = Array.isArray(authored?._images) ? authored._images : [];
  delete authored._images;
  const session = authored.session ? sessions.get(authored.session) : null;
  return toolResult(finalizeOfficeResult(authored, { action: 'author', session, startedAt }), false, images);
}

/** @returns {Promise<object|null>} the tool result, or null when the action needs a session. */
export async function runSessionlessOfficeAction({ action, args, cwd, dataDir, signal, startedAt }) {
  if (action === 'detect') return await detectAction(args, cwd, dataDir);
  if (action === 'transactions') {
    return toolResult({ ok: true, transactions: await pendingOfficeTransactions(dataDir) });
  }
  if (action === 'recover') return toolResult(await recoverOfficeTransaction(args, dataDir));
  if (action === 'secure') return await secureAction(args, cwd, startedAt);
  if (action === 'describe' && !args.session) return await describeWithoutSession(args, cwd);
  if (action === 'author') return await authorAction(args, cwd, dataDir, signal, startedAt);
  if (action === 'open' || action === 'attach' || action === 'create') {
    return await openCreateOrAttachOffice({ action, args, cwd, dataDir, signal, startedAt });
  }
  return null;
}
