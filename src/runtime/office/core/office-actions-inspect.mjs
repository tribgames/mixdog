import { copyFile, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { callMicrosoftOffice } from '../com/com-adapter.mjs';
import { issuesPortableOoxml, validateLibreOfficeReopen, validatePortableOoxml } from '../portable/portable-ooxml.mjs';
import { issuesPdf, validatePdf } from '../pdf/pdf-adapter.mjs';
import { validateOoxmlSchema } from '../portable/ooxml-validator.mjs';
import { evaluateXlsxAssertions } from '../portable/xlsx-assertions.mjs';
import { mergeXlsxFormulaAudit } from '../portable/xlsx-formula-audit.mjs';
import { issuesTabular, validateTabular } from './tabular.mjs';
import { evaluateOfficeSubmissionGate, normalizeOfficeReviewIssues } from '../quality/quality-pipeline.mjs';
import { reviewOfficeStructure } from '../quality/assurance.mjs';
import { OOXML_FORMATS, TABULAR_FORMATS } from './office-core.mjs';
import { snapshot } from './office-sessions.mjs';

// One document read per document version for every review that needs the whole
// document: issues and qa both ask for it, and reading it twice per call costs
// the caller seconds on a large workbook.
const reviewSnapshots = new WeakMap();

export async function reviewSnapshot(session, args = {}) {
  const version = Number(session.snapshotVersion || 0);
  const cached = reviewSnapshots.get(session);
  if (cached && cached.version === version) return cached.read;
  const read = await snapshot(
    session,
    {
      ...args,
      includeStyles: true,
      limit: Math.min(100, Number(args.limit) || 100),
      maxChars: 100_000,
    },
    { full: true }
  );
  reviewSnapshots.set(session, { version, read });
  return read;
}

// What the format review owns — an orphan heading, a chart the page break cuts,
// a sheet with no reading order — is read from the document, not the package.
// Without it `issues` answered "ok, nothing found" for a file qa reports on.
async function structureIssues(session, args) {
  if (!['docx', 'xlsx', 'pptx'].includes(session.format)) return [];
  try {
    const read = await reviewSnapshot(session, args);
    if (!read?.document) return [];
    return reviewOfficeStructure({
      format: session.format,
      document: read.document,
      auditProfile: args.auditProfile,
    });
  } catch {
    // A document the reader cannot open is already reported by the package
    // checks; the review simply has nothing to add.
    return [];
  }
}

// The Office host's own read of the document; null off the COM backend.
async function nativeValidation(session, args) {
  if (session.backend !== 'microsoft-office-com') return null;
  if (args.__skipNative === true) {
    return { ok: true, opened: true, issueCount: 0, issues: [], documentSaved: true, reusedReview: true };
  }
  const postSaveNativeValidation = args.__postSave === true || session.mode === 'background';
  const response = await callMicrosoftOffice(
    {
      action: postSaveNativeValidation ? 'post_save_validate' : 'validate',
      session: session.id,
      format: session.format,
      mode: session.mode,
      path: session.target,
      inspectIssues: args.__skipNativeIssues !== true,
    },
    {
      signal: session.activeSignal || null,
      timeoutMs: postSaveNativeValidation ? 300_000 : undefined,
    }
  );
  if (!response.ok) throw new Error(response.error || 'Microsoft Office native validation failed');
  return response.value;
}

function packageValidation(session, args) {
  if (session.format === 'pdf') return validatePdf(session.target);
  if (TABULAR_FORMATS.has(session.format)) return validateTabular(session.target, session.format);
  return validatePortableOoxml(session.target, session.format, {
    original: session.source !== session.target ? session.source : '',
    savedBy: session.backend,
    auditProfile: args.auditProfile,
    author: args.author,
  });
}

// OOXML schema validation; the COM backend holds the file open, so the
// validator reads a copy.
async function schemaValidation(session, args) {
  if (!OOXML_FORMATS.has(session.format)) return null;
  let schemaCopy = '';
  try {
    if (session.backend === 'microsoft-office-com') {
      schemaCopy = join(tmpdir(), `mixdog-schema-${randomUUID()}${extname(session.target)}`);
      await copyFile(session.target, schemaCopy);
    }
    return await validateOoxmlSchema(schemaCopy || session.target, {
      dataDir: session.dataDir,
      download: args.downloadDependencies !== false,
      signal: session.activeSignal || null,
    });
  } catch (error) {
    return { available: false, ok: false, errors: [], reason: error?.message || String(error) };
  } finally {
    if (schemaCopy) await rm(schemaCopy, { force: true }).catch(() => {});
  }
}

async function assertionValidation(session, args) {
  if (!Array.isArray(args.assertions) || !args.assertions.length) return null;
  if (session.format !== 'xlsx') throw new Error('assertions are supported for XLSX sessions only');
  const asserted = await snapshot(session, { limit: 10_000, maxChars: 100_000, includeStyles: false }, { full: true });
  return evaluateXlsxAssertions(asserted.document, args.assertions);
}

export async function validate(session, args = {}) {
  const native = await nativeValidation(session, args);
  const packageResult = await packageValidation(session, args);
  const schema = await schemaValidation(session, args);
  const assertions = await assertionValidation(session, args);
  const compatibility =
    args.compatibility === true && ['docx', 'xlsx', 'pptx'].includes(session.format)
      ? await validateLibreOfficeReopen(session.target, { signal: session.activeSignal || null })
      : null;
  const postSaveGate =
    native?.persisted != null
      ? evaluateOfficeSubmissionGate({
          issues: native?.issues || [],
          persisted: native?.persisted === true,
        })
      : null;
  return {
    session: session.id,
    mode: session.mode,
    backend: session.backend,
    path: session.target,
    ...packageResult,
    ok:
      packageResult.ok &&
      (!schema ||
        schema.ok ||
        schema.disabled === true ||
        (args.downloadDependencies === false && schema.downloadRequired === true)) &&
      (!assertions || assertions.ok) &&
      (!native || (native.ok && (session.mode === 'background' || native.documentSaved))) &&
      (!postSaveGate || postSaveGate.ok) &&
      (!compatibility?.available || compatibility.opened),
    schema,
    assertions,
    native,
    postSaveGate,
    compatibility,
  };
}

// PowerPoint's host reads what COM exposes: text bounds, a shape's own fill, fonts, edges. The measured
// read the portable backend runs on the package — vertical balance and hollow bands, contrast against the
// plane that actually covers a box, block spacing, stat labels, fragmentation, dead vector charts, chart
// package faults — never ran on a PowerPoint session, so the same deck passed on one backend and failed
// on the other. The live document is copied aside (never saved over the user's file) and read as a
// package; the host's own overflow verdict, measured by PowerPoint itself, stays authoritative.
const HOST_OWNED_PPTX_CODES = new Set(['text_overflow']);

async function mergeComPptxMeasuredRead(session, result, args) {
  const copy = join(tmpdir(), `mixdog-pptx-measure-${randomUUID()}.pptx`);
  try {
    const saved = await callMicrosoftOffice(
      {
        action: 'save_copy',
        session: session.id,
        format: session.format,
        mode: session.mode,
        path: session.target,
        output: copy,
      },
      { signal: session.activeSignal || null, timeoutMs: 120_000 }
    );
    if (!saved.ok)
      return { ...result, measuredRead: { status: 'unavailable', reason: saved.error || 'save-copy failed' } };
    const measured = await issuesPortableOoxml(copy, 'pptx', args);
    const seen = new Set((result.issues || []).map((issue) => `${issue.code}|${issue.path}`));
    const added = (measured.issues || []).filter(
      (issue) => !HOST_OWNED_PPTX_CODES.has(String(issue.code || '')) && !seen.has(`${issue.code}|${issue.path}`)
    );
    if (!added.length) return { ...result, measuredRead: { status: 'merged', added: 0 } };
    const issues = normalizeOfficeReviewIssues([...(result.issues || []), ...added]);
    return {
      ...result,
      issues,
      issueCount: issues.length,
      ok: !issues.some((entry) => entry.severity === 'error'),
      measuredRead: { status: 'merged', added: added.length },
    };
  } catch (error) {
    return { ...result, measuredRead: { status: 'unavailable', reason: error?.message || String(error) } };
  } finally {
    await rm(copy, { force: true }).catch(() => {});
  }
}

async function microsoftOfficeIssues(session, args) {
  const response = await callMicrosoftOffice(
    {
      action: 'issues',
      session: session.id,
      format: session.format,
      mode: session.mode,
      path: session.target,
      sheet: args.sheet,
      range: args.range,
      pages: args.pages,
      target: args.target,
      auditProfile: args.auditProfile,
    },
    {
      signal: session.activeSignal || null,
      timeoutMs: args.auditProfile === 'financial-model' ? 300_000 : undefined,
    }
  );
  if (!response.ok) throw new Error(response.error || 'Microsoft Office issue inspection failed');
  let result = response.value;
  // Excel's host reports its own subset; the shared formula audit reads the
  // same cells (cached for an owned background session) and adds the rest.
  if (session.format === 'xlsx') {
    const read = await snapshot(session, { includeStyles: true }, { full: true });
    result = mergeXlsxFormulaAudit(result, read?.document, { auditProfile: args.auditProfile, sheet: args.sheet });
  }
  if (session.format === 'pptx') result = await mergeComPptxMeasuredRead(session, result, args);
  return result;
}

function portableIssues(session, args) {
  if (session.format === 'pdf') return issuesPdf(session.target, args);
  if (TABULAR_FORMATS.has(session.format)) return issuesTabular(session.target, session.format, args);
  return issuesPortableOoxml(session.target, session.format, args);
}

export async function issues(session, args = {}) {
  const result =
    session.backend === 'microsoft-office-com'
      ? await microsoftOfficeIssues(session, args)
      : await portableIssues(session, args);
  const structural = await structureIssues(session, args);
  const merged = structural.length
    ? normalizeOfficeReviewIssues([...(result.issues || []), ...structural])
    : result.issues;
  return {
    session: session.id,
    mode: session.mode,
    backend: session.backend,
    path: session.target,
    ...result,
    ...(structural.length
      ? {
          issues: merged,
          issueCount: merged.length,
          ok: !merged.some((entry) => entry.severity === 'error'),
        }
      : {}),
  };
}
