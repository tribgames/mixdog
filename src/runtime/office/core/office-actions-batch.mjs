import { copyFile, rename, rm } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { callMicrosoftOffice } from '../com/com-adapter.mjs';
import { applyPortableOoxmlBatch, clearPortablePresentationSlides } from '../portable/portable-ooxml.mjs';
import { applyPdfBatch } from '../pdf/pdf-adapter.mjs';
import { assertOfficeOperationContracts } from '../capabilities.mjs';
import { validateXlsxOperations } from '../portable/xlsx-contract.mjs';
import { applyTabularBatch } from './tabular.mjs';
import { expandOfficeDesignOperations } from '../design/design-system.mjs';
import { createPptxSlideSelection } from '../design/library/design-library.mjs';
import { assertOfficeMutationAllowed } from '../quality/assurance.mjs';
import { TABULAR_FORMATS, isMicrosoftOfficeSession, mergeOfficeDesignRequest } from './office-core.mjs';
import { fullPath, trustForMutation } from './office-sessions.mjs';
import {
  assertTransactionUnchanged,
  captureSessionState,
  persistOfficeTransaction,
  recordTransactionOperations,
  transactionDocumentDiff,
  transactionView,
} from './office-transactions.mjs';

export async function applyBatch(session, args) {
  const trust = await trustForMutation(session);
  assertOfficeMutationAllowed({
    trust,
    acknowledged: args.acknowledgeUntrustedContent === true,
  });
  const designRequest = mergeOfficeDesignRequest(session.designRequest, args.design);
  assertOfficeOperationContracts({
    format: session.format,
    backend: session.backend,
    operations: Array.isArray(args.operations) ? args.operations : [],
  });
  const prepared = expandOfficeDesignOperations({
    format: session.format,
    backend: session.backend,
    operations: Array.isArray(args.operations) ? args.operations : [],
    design: designRequest,
    library: session.designLibrary,
    created: session.created === true,
    snapshotVersion: session.snapshotVersion,
  });
  session.designRequest = designRequest;
  session.design = prepared.design;
  session.designState ||= {
    renderedVersion: null,
    semanticCount: 0,
    requiresVisualReview: false,
    slidePlans: [],
    compositions: [],
  };
  const pathOperations = new Set(['add_image', 'replace_image', 'stamp_image', 'add_attachment', 'merge_pdf', 'apply_theme', 'import_slides', 'add_media']);
  const operations = Array.isArray(prepared.operations)
    ? prepared.operations.map((operation) => {
        let normalized = operation;
        if (operation?.path && pathOperations.has(String(operation.op || ''))) {
          normalized = { ...normalized, path: fullPath(operation.path, args.__cwd || dirname(session.target)) };
        }
        if (operation?.fontPath && ['add_text', 'watermark', 'ocr_pages'].includes(String(operation.op || ''))) {
          normalized = { ...normalized, fontPath: fullPath(operation.fontPath, args.__cwd || dirname(session.target)) };
        }
        return normalized;
      })
    : [];
  if (!operations.length) throw new Error('batch requires at least one operation');
  if (
    session.format === 'pptx'
    && operations.some((operation) => operation.op === 'import_slides')
    && operations.some((operation) => operation.op === 'keep_slides')
  ) {
    throw new Error('Run keep_slides in a later batch after import_slides has been saved');
  }
  assertOfficeOperationContracts({
    format: session.format,
    backend: session.backend,
    operations,
  });
  if (session.format === 'xlsx' || TABULAR_FORMATS.has(session.format)) validateXlsxOperations(operations);
  const transaction = session.transaction;
  if (transaction) {
    await assertTransactionUnchanged(session);
    transaction.phase = 'applying';
    try {
      await persistOfficeTransaction(session);
    } catch (error) {
      transaction.phase = 'active';
      throw error;
    }
  }
  const target = session.target;
  const emptyDeckReplacement = session.backend === 'microsoft-office-com'
    && session.format === 'pptx'
    && session.mode === 'background'
    && session.created === true
    && Number(session.snapshotVersion || 0) === 0
    && operations[0].op === 'import_slides'
    && Number(operations[0].after || 0) === 0
    && extname(operations[0].path).toLowerCase() === extname(target).toLowerCase();
  const portableTemplateSeed = session.backend === 'mixdog-ooxml'
    && session.format === 'pptx'
    && session.created === true
    && Number(session.snapshotVersion || 0) === 0
    && operations.some((operation) => operation.op === 'import_slides')
    ? operations.find((operation) => operation.op === 'import_slides').path
    : '';
  const needsComCheckpoint = isMicrosoftOfficeSession(session)
    && session.mode === 'background'
    && operations.some((operation) => operation.op === 'import_slides');
  const backup = !isMicrosoftOfficeSession(session) || needsComCheckpoint
    ? `${target}.mixdog-backup-${randomUUID()}`
    : '';
  const replacementSource = emptyDeckReplacement && Array.isArray(operations[0]?.slides)
    ? join(tmpdir(), `mixdog-pptx-selection-${randomUUID()}.pptx`)
    : '';
  if (replacementSource) {
    await createPptxSlideSelection(operations[0].path, operations[0].slides, replacementSource);
  }
  if (backup && needsComCheckpoint) {
    const checkpoint = await callMicrosoftOffice({
      action: 'save_copy',
      session: session.id,
      format: session.format,
      mode: session.mode,
      path: target,
      output: backup,
    }, {
      signal: session.activeSignal || null,
      timeoutMs: 120_000,
    });
    if (!checkpoint.ok) {
      throw new Error(`Microsoft Office save-copy checkpoint failed: ${checkpoint.error || 'unknown error'}`);
    }
  } else if (backup) {
    await copyFile(target, backup);
  }
  try {
    let results;
    let saved = true;
    let undoUnits = 0;
    let backgroundIsolation = session.backgroundIsolation || null;
    if (session.backend === 'microsoft-office-com') {
      if (emptyDeckReplacement) {
        const operation = operations[0];
        const replaced = await callMicrosoftOffice({
          action: 'replace_presentation_from_source',
          session: session.id,
          format: session.format,
          mode: session.mode,
          path: target,
          source: replacementSource || operation.path,
          ...(replacementSource ? {} : { slides: operation.slides }),
          checkpoint: backup,
        }, {
          signal: session.activeSignal || null,
          timeoutMs: 120_000,
        });
        if (!replaced.ok) {
          throw new Error(`PowerPoint source replacement failed: ${replaced.error || 'unknown error'}`);
        }
        backgroundIsolation = replaced.backgroundIsolation || backgroundIsolation;
        results = Array.isArray(replaced.results) ? replaced.results : [replaced.results];
        const remaining = operations.slice(1);
        if (remaining.length) {
          const result = await callMicrosoftOffice({
            action: 'batch',
            session: session.id,
            format: session.format,
            mode: session.mode,
            path: target,
            operations: remaining,
            save: args.save === true,
            requireChanges: args.requireChanges !== false,
          }, {
            signal: session.activeSignal || null,
            timeoutMs: Math.min(300_000, 90_000 + (remaining.length * 500)),
          });
          if (!result.ok) throw new Error(result.error || 'Microsoft Office batch failed after native template import');
          backgroundIsolation = result.backgroundIsolation || backgroundIsolation;
          results.push(...(Array.isArray(result.results) ? result.results : [result.results]));
          saved = result.saved;
          undoUnits = Number(result.undoUnits) || 0;
        } else {
          saved = replaced.saved === true;
        }
      } else {
        const result = await callMicrosoftOffice({
          action: 'batch',
          session: session.id,
          format: session.format,
          mode: session.mode,
          path: target,
          operations,
          save: args.save === true,
          requireChanges: args.requireChanges !== false,
        }, {
          signal: session.activeSignal || null,
          timeoutMs: Math.min(300_000, 90_000 + (operations.length * 500)),
        });
        if (!result.ok) throw new Error(result.error || 'Microsoft Office batch failed');
        backgroundIsolation = result.backgroundIsolation || backgroundIsolation;
        results = result.results;
        saved = result.saved;
        undoUnits = Number(result.undoUnits) || 0;
      }
    } else if (session.format === 'pdf') {
      results = await applyPdfBatch(target, operations, {
        dataDir: session.dataDir,
        signal: session.activeSignal || null,
      });
    } else if (TABULAR_FORMATS.has(session.format)) {
      results = await applyTabularBatch(target, session.format, operations);
    } else if (portableTemplateSeed) {
      await copyFile(portableTemplateSeed, target);
      await clearPortablePresentationSlides(target);
      results = await applyPortableOoxmlBatch(target, session.format, operations);
    } else {
      results = await applyPortableOoxmlBatch(target, session.format, operations);
    }
    results = (Array.isArray(results) ? results : [results])
      .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
    const noChange = results.filter((entry) => entry.changed === false);
    if (args.requireChanges !== false && noChange.length && session.backend !== 'microsoft-office-com') {
      throw new Error(`Office batch produced no change for: ${noChange.map((entry) => entry.op || 'operation').join(', ')}`);
    }
    let transactionResult;
    if (transaction) {
      const current = await captureSessionState(session);
      transaction.expectedFingerprint = current.fingerprint;
      transaction.currentDocument = current.document;
      transaction.undoUnits += undoUnits;
      recordTransactionOperations(transaction, session.format, operations, results);
      transaction.diff = transactionDocumentDiff(transaction, current.document);
      transaction.phase = 'active';
      let journalWarning = '';
      try {
        await persistOfficeTransaction(session);
      } catch (error) {
        journalWarning = error?.message || String(error);
      }
      transactionResult = transactionView(transaction);
      if (journalWarning) transactionResult.journalWarning = journalWarning;
    }
    session.designState.semanticCount += prepared.semantic.length;
    session.designState.compositions = [
      ...(session.designState.compositions || []),
      ...prepared.semantic.map((entry) => entry?.composition).filter(Boolean),
    ];
    if (session.format === 'pptx' && session.design.review.required) {
      session.designState.requiresVisualReview = true;
      const existingPlans = new Map((session.designState.slidePlans || []).map((plan) => [Number(plan.slide), plan]));
      for (const semantic of prepared.semantic) {
        if (semantic?.plan && Number(semantic.slide) > 0) {
          existingPlans.set(Number(semantic.slide), {
            ...semantic.plan,
            kind: semantic.kind,
            slideRole: semantic.slideRole,
            backgroundRole: semantic.backgroundRole,
          });
        }
      }
      session.designState.slidePlans = [...existingPlans.values()].sort((left, right) => left.slide - right.slide);
    }
    session.snapshotVersion = Number(session.snapshotVersion || 0) + 1;
    session.designState.renderedVersion = null;
    session.backgroundIsolation = backgroundIsolation;
    return {
      ok: true,
      session: session.id,
      mode: session.mode,
      backend: session.backend,
      output: target,
      saved,
      atomic: true,
      results,
      changeSummary: {
        requested: operations.length,
        changed: results.filter((entry) => entry.changed === true).length,
        noChange: noChange.length,
      },
      design: session.design,
      semanticOperations: prepared.semantic,
      ...(backgroundIsolation ? { backgroundIsolation } : {}),
      trust,
      ...(transactionResult ? { transaction: transactionResult } : {}),
    };
  } catch (error) {
    if (backup && emptyDeckReplacement) {
      await callMicrosoftOffice({
        action: 'replace_presentation_from_source',
        session: session.id,
        format: session.format,
        mode: session.mode,
        path: target,
        source: backup,
        checkpoint: backup,
      }, {
        signal: session.activeSignal || null,
        timeoutMs: 120_000,
      }).catch(() => {});
    } else if (backup) {
      await rm(target, { force: true }).catch(() => {});
      await rename(backup, target).catch(() => {});
    }
    if (transaction) {
      transaction.phase = 'active';
      await persistOfficeTransaction(session).catch(() => {});
    }
    throw error;
  } finally {
    if (backup) await rm(backup, { force: true }).catch(() => {});
    if (replacementSource) await rm(replacementSource, { force: true }).catch(() => {});
  }
}
