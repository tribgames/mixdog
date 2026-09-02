import { copyFile, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { callMicrosoftOffice } from '../com/com-adapter.mjs';
import { issuesPortableOoxml, validateLibreOfficeReopen, validatePortableOoxml } from '../portable/portable-ooxml.mjs';
import { issuesPdf, validatePdf } from '../pdf/pdf-adapter.mjs';
import { validateOoxmlSchema } from '../portable/ooxml-validator.mjs';
import { evaluateXlsxAssertions } from '../portable/xlsx-assertions.mjs';
import { issuesTabular, validateTabular } from './tabular.mjs';
import { evaluateOfficeSubmissionGate } from '../quality/quality-pipeline.mjs';
import { OOXML_FORMATS, TABULAR_FORMATS, sessions } from './office-core.mjs';
import { snapshot } from './office-sessions.mjs';

export async function validate(session, args = {}) {
  let native = null;
  if (session.backend === 'microsoft-office-com') {
    const postSaveNativeValidation = args.__postSave === true || session.mode === 'background';
    if (args.__skipNative === true) {
      native = {
        ok: true,
        opened: true,
        issueCount: 0,
        issues: [],
        documentSaved: true,
        reusedReview: true,
      };
    } else {
      const response = await callMicrosoftOffice({
        action: postSaveNativeValidation ? 'post_save_validate' : 'validate',
        session: session.id,
        format: session.format,
        mode: session.mode,
        path: session.target,
        inspectIssues: args.__skipNativeIssues !== true,
      }, {
        signal: session.activeSignal || null,
        timeoutMs: postSaveNativeValidation ? 300_000 : undefined,
      });
      if (!response.ok) throw new Error(response.error || 'Microsoft Office native validation failed');
      native = response.value;
    }
  }
  const packageResult = session.format === 'pdf'
    ? await validatePdf(session.target)
    : TABULAR_FORMATS.has(session.format)
      ? await validateTabular(session.target, session.format)
      : await validatePortableOoxml(session.target, session.format, {
          original: session.source !== session.target ? session.source : '',
          auditProfile: args.auditProfile,
          author: args.author,
      });
  let schema = null;
  if (OOXML_FORMATS.has(session.format)) {
    let schemaCopy = '';
    try {
      if (session.backend === 'microsoft-office-com') {
        schemaCopy = join(tmpdir(), `mixdog-schema-${randomUUID()}${extname(session.target)}`);
        await copyFile(session.target, schemaCopy);
      }
      schema = await validateOoxmlSchema(schemaCopy || session.target, {
        dataDir: session.dataDir,
        download: args.downloadDependencies !== false,
        signal: session.activeSignal || null,
      });
    } catch (error) {
      schema = {
        available: false,
        ok: false,
        errors: [],
        reason: error?.message || String(error),
      };
    } finally {
      if (schemaCopy) await rm(schemaCopy, { force: true }).catch(() => {});
    }
  }
  let assertions = null;
  if (Array.isArray(args.assertions) && args.assertions.length) {
    if (session.format !== 'xlsx') throw new Error('assertions are supported for XLSX sessions only');
    const asserted = await snapshot(session, {
      limit: 10_000,
      maxChars: 100_000,
      includeStyles: false,
    }, { full: true });
    assertions = evaluateXlsxAssertions(asserted.document, args.assertions);
  }
  const compatibility = args.compatibility === true && ['docx', 'xlsx', 'pptx'].includes(session.format)
    ? await validateLibreOfficeReopen(session.target)
    : null;
  const postSaveGate = native?.persisted != null
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
    ok: packageResult.ok
      && (!schema || schema.ok || schema.disabled === true || (args.downloadDependencies === false && schema.downloadRequired === true))
      && (!assertions || assertions.ok)
      && (!native || (native.ok && (session.mode === 'background' || native.documentSaved)))
      && (!postSaveGate || postSaveGate.ok)
      && (!compatibility?.available || compatibility.opened),
    schema,
    assertions,
    native,
    postSaveGate,
    compatibility,
  };
}

export async function issues(session, args = {}) {
  let result;
  if (session.backend === 'microsoft-office-com') {
    const response = await callMicrosoftOffice({
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
    }, {
      signal: session.activeSignal || null,
      timeoutMs: args.auditProfile === 'financial-model' ? 300_000 : undefined,
    });
    if (!response.ok) throw new Error(response.error || 'Microsoft Office issue inspection failed');
    result = response.value;
  } else {
    result = session.format === 'pdf'
      ? await issuesPdf(session.target, args)
      : TABULAR_FORMATS.has(session.format)
      ? await issuesTabular(session.target, session.format, args)
      : await issuesPortableOoxml(session.target, session.format, args);
  }
  return {
    session: session.id,
    mode: session.mode,
    backend: session.backend,
    path: session.target,
    ...result,
  };
}
