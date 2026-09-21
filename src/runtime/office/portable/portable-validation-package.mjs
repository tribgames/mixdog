// Package-level validation of a portable OOXML file: XML parts, content
// types, protected-part baseline and redlining checks.
import { posix } from 'node:path';
import { createHash } from 'node:crypto';
import { loadPackage, relationshipTarget, zipText } from './portable-opc.mjs';
import { auditDocxRedliningStories, lintDocxRevisions } from './docx-revisions.mjs';
import { OOXML_REQUIRED, xmlAttribute, xmlDecode } from './portable-xml.mjs';

async function inspectXmlParts(zip, entries) {
  const malformedXml = [];
  const xmlEntries = entries.filter((name) => /\.(?:xml|rels)$/i.test(name));
  const { JSDOM } = await import('jsdom');
  for (const name of xmlEntries) {
    try {
      const xml = await zipText(zip, name);
      const dom = new JSDOM(xml, { contentType: 'text/xml' });
      dom.window.close();
    } catch (error) {
      malformedXml.push({ part: name, error: error?.message || String(error) });
    }
  }
  return malformedXml;
}

function contentTypeCoverage(entries, xml, format) {
  const defaults = new Map();
  const overrides = new Map();
  for (const match of xml.matchAll(/<Default\b([^>]*?)\/?>/gi)) {
    defaults.set(xmlAttribute(match[1], 'Extension').toLowerCase(), xmlAttribute(match[1], 'ContentType'));
  }
  for (const match of xml.matchAll(/<Override\b([^>]*?)\/?>/gi)) {
    overrides.set(xmlAttribute(match[1], 'PartName').replace(/^\/+/, ''), xmlAttribute(match[1], 'ContentType'));
  }
  const missingContentTypes = entries.filter((name) => {
    if (name === '[Content_Types].xml') return false;
    if (overrides.has(name)) return false;
    const extension = name.toLowerCase().endsWith('.rels') ? 'rels' : posix.extname(name).slice(1).toLowerCase();
    return !extension || !defaults.has(extension);
  });
  const mainPart = OOXML_REQUIRED[format]?.[1] || '';
  const mainContentType = overrides.get(mainPart) || '';
  return {
    missingContentTypes,
    mainPart,
    mainContentType,
    mainContentTypeMissing: Boolean(mainPart && !mainContentType),
  };
}

/** The chart data workbooks a package's chart relationships point at (native chart evidence, not activatable objects). */
async function chartWorkbooksOf(zip, entries) {
  const workbooks = new Set();
  for (const relPath of entries.filter((name) => /(?:^|\/)charts\/_rels\/chart[^/]*\.xml\.rels$/i.test(name))) {
    const xml = await zipText(zip, relPath);
    for (const match of xml.matchAll(/<Relationship\b([^>]+?)\/?>/gi)) {
      if (!/\/package$/i.test(xmlAttribute(match[1], 'Type'))) continue;
      const target = xmlAttribute(match[1], 'Target');
      workbooks.add(posix.normalize(posix.join(posix.dirname(relPath.replace('_rels/', '')), target)));
    }
  }
  return workbooks;
}

// The parts a rewrite must carry through untouched. When the Office application itself saved the file (the
// background backend), masters, layouts and themes are normalised by that save and a chart's data workbook may be
// renumbered (Microsoft_Excel_Worksheet2.xlsx → Microsoft_Excel_Worksheet.xlsx): those are the application's own
// serialisation, not damage, and are reported as normalised instead. Macros, signatures, ribbon customisation,
// external links, connections and embedded objects stay protected under every backend.
const PROTECTED_ALWAYS =
  /(?:^|\/)(?:vbaProject\.bin|vbaData\.xml|_xmlsignatures\/|origin\.sigs$|signatures?\.xml$|customUI\/|embeddings\/|externalLinks\/|connections\.xml$)/i;
const PROTECTED_UNLESS_APPLICATION_SAVED = /(?:^|\/)(?:slideMasters\/|slideLayouts\/|theme\/)/i;
// The parts a digital signature is stored in.
const SIGNATURE_PART = /(?:^|\/)(?:_xmlsignatures\/|origin\.sigs$|signatures?\.xml$)/i;
const APPLICATION_BACKENDS = new Set(['microsoft-office-com']);

function packageEntryNames(zip) {
  return Object.entries(zip.files)
    .filter(([, entry]) => !entry.dir)
    .map(([name]) => name);
}

const partHash = async (entry) =>
  createHash('sha256')
    .update(await entry.async('nodebuffer'))
    .digest('hex');

// Every original part against the saved copy: the protected ones that changed,
// the ones the application itself rewrote or dropped, and everything that differs.
async function comparePackageParts(
  zip,
  originalZip,
  originalEntries,
  { applicationSaved, isProtected, renumberedWorkbook }
) {
  const applicationNormalized = (name) =>
    applicationSaved && (PROTECTED_UNLESS_APPLICATION_SAVED.test(name) || renumberedWorkbook(name));
  const changedProtectedParts = [];
  const applicationNormalizedParts = [];
  const changedParts = [];
  for (const name of originalEntries) {
    const current = zip.file(name);
    if (!current) {
      if (applicationNormalized(name)) applicationNormalizedParts.push(name);
      continue;
    }
    const [before, after] = await Promise.all([partHash(originalZip.file(name)), partHash(current)]);
    if (before === after) continue;
    changedParts.push(name);
    if (isProtected(name) && !renumberedWorkbook(name)) changedProtectedParts.push({ part: name, before, after });
    else if (applicationNormalized(name)) applicationNormalizedParts.push(name);
  }
  return { changedProtectedParts, applicationNormalizedParts, changedParts };
}

async function baselinePackage(zip, original, { savedBy = '', chartWorkbooks = new Set() } = {}) {
  if (!original) return { compared: false };
  const originalZip = await loadPackage(original);
  const applicationSaved = APPLICATION_BACKENDS.has(savedBy);
  const currentEntries = new Set(packageEntryNames(zip));
  const originalEntries = packageEntryNames(originalZip);
  const originalChartWorkbooks = applicationSaved ? await chartWorkbooksOf(originalZip, originalEntries) : new Set();
  // A chart workbook the application renumbered is not lost while the saved package still carries one per chart.
  const renumberedWorkbook = (name) =>
    applicationSaved && originalChartWorkbooks.has(name) && chartWorkbooks.size >= originalChartWorkbooks.size;
  const isProtected = (name) =>
    PROTECTED_ALWAYS.test(name) || (!applicationSaved && PROTECTED_UNLESS_APPLICATION_SAVED.test(name));
  const protectedParts = originalEntries.filter((name) => isProtected(name) && !renumberedWorkbook(name));
  const compared = await comparePackageParts(zip, originalZip, originalEntries, {
    applicationSaved,
    isProtected,
    renumberedWorkbook,
  });
  const signatureParts = originalEntries.filter((name) => SIGNATURE_PART.test(name));
  return {
    compared: true,
    original,
    savedBy,
    applicationSaved,
    originalEntries: originalEntries.length,
    addedParts: [...currentEntries].filter((name) => !originalZip.file(name)),
    lostProtectedParts: protectedParts.filter((name) => !currentEntries.has(name)),
    changedProtectedParts: compared.changedProtectedParts,
    applicationNormalizedParts: compared.applicationNormalizedParts,
    signatureParts,
    digitalSignatureInvalidated: signatureParts.length > 0 && compared.changedParts.length > 0,
  };
}

const DOCX_STORY_PART = /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/i;

/** Every story part by name: the audit compares each one with its source
 *  counterpart, so a header edited untracked is caught like the body. */
async function docxStoryParts(zip) {
  const parts = new Map();
  for (const name of Object.keys(zip.files)
    .filter((entry) => DOCX_STORY_PART.test(entry))
    .sort()) {
    parts.set(name, await zipText(zip, name));
  }
  return parts;
}

async function validateDocxRedlining(zip, originalPath, author = '') {
  if (!originalPath) {
    return {
      requested: true,
      ok: false,
      reason: 'Redlining audit requires an opened source document.',
    };
  }
  try {
    const original = await loadPackage(originalPath);
    return auditDocxRedliningStories(await docxStoryParts(zip), await docxStoryParts(original), { author });
  } catch (error) {
    return {
      requested: true,
      ok: false,
      reason: error?.message || String(error),
    };
  }
}

// Every .rels part: duplicate ids, external targets, and targets that do
// not resolve to a package entry.
async function relationshipIssues(zip, entries) {
  const missingRelationships = [];
  const duplicateRelationshipIds = [];
  const externalRelationships = [];
  for (const relPath of entries.filter((name) => name.endsWith('.rels'))) {
    const xml = await zipText(zip, relPath);
    const ids = new Set();
    for (const match of xml.matchAll(/<Relationship\b([^>]+?)\/?>/gi)) {
      const id = xmlAttribute(match[1], 'Id');
      const target = xmlAttribute(match[1], 'Target');
      const mode = xmlAttribute(match[1], 'TargetMode');
      if (id && ids.has(id)) duplicateRelationshipIds.push({ relationship: relPath, id });
      if (id) ids.add(id);
      if (mode.toLowerCase() === 'external') {
        externalRelationships.push({ relationship: relPath, id, target: xmlDecode(target) });
        continue;
      }
      const resolved = relationshipTarget(relPath, target);
      if (!resolved || resolved.startsWith('../') || !zip.file(resolved)) {
        missingRelationships.push({ relationship: relPath, id, target: xmlDecode(target), resolved });
      }
    }
  }
  return { missingRelationships, duplicateRelationshipIds, externalRelationships };
}

async function docxDocumentLint(zip, entries) {
  return lintDocxRevisions(
    await Promise.all(
      entries
        .filter((name) => DOCX_STORY_PART.test(name))
        .sort()
        .map(async (name) => ({ part: name, xml: await zipText(zip, name) }))
    ),
    await zipText(zip, 'word/comments.xml')
  );
}

function packageEntryFindings(entries, chartWorkbooks) {
  return {
    unsafeEntries: entries.filter((name) => name.includes('..') || name.startsWith('/') || /^[A-Za-z]:/.test(name)),
    macros: entries.filter((name) => /vbaProject\.bin$/i.test(name)),
    signatures: entries.filter((name) => SIGNATURE_PART.test(name)),
    externalLinks: entries.filter((name) => /(?:^|\/)externalLinks\//i.test(name)),
    dataConnections: entries.filter((name) => /(?:^|\/)connections\.xml$/i.test(name)),
    // A chart's data workbook is native chart evidence, not an activatable
    // object: it is excluded from the embedded-object security finding.
    embeddedObjects: entries.filter((name) => /(?:^|\/)embeddings\//i.test(name) && !chartWorkbooks.has(name)),
  };
}

function ooxmlPackageOk({
  missing,
  documentLint,
  findings,
  malformedXml,
  contentTypes,
  relationships,
  baseline,
  redlining,
}) {
  return (
    missing.length === 0 &&
    !documentLint.some((finding) => finding.severity === 'error') &&
    findings.unsafeEntries.length === 0 &&
    malformedXml.length === 0 &&
    contentTypes.missingContentTypes.length === 0 &&
    !contentTypes.mainContentTypeMissing &&
    relationships.missingRelationships.length === 0 &&
    relationships.duplicateRelationshipIds.length === 0 &&
    !baseline.lostProtectedParts?.length &&
    !baseline.changedProtectedParts?.length &&
    baseline.digitalSignatureInvalidated !== true &&
    (!redlining || redlining.ok)
  );
}

export async function validatePortableOoxml(path, format, options = {}) {
  const zip = await loadPackage(path);
  const entries = packageEntryNames(zip);
  const missing = (OOXML_REQUIRED[format] || []).filter((name) => !zip.file(name));
  const chartWorkbooks = await chartWorkbooksOf(zip, entries);
  const findings = packageEntryFindings(entries, chartWorkbooks);
  const malformedXml = await inspectXmlParts(zip, entries);
  const contentTypes = contentTypeCoverage(entries, await zipText(zip, '[Content_Types].xml'), format);
  const relationships = await relationshipIssues(zip, entries);
  const baseline = await baselinePackage(zip, options.original, { savedBy: options.savedBy, chartWorkbooks });
  const documentLint = format === 'docx' ? await docxDocumentLint(zip, entries) : [];
  const redlining =
    format === 'docx' && options.auditProfile === 'redlining'
      ? await validateDocxRedlining(zip, options.original, options.author)
      : null;
  return {
    ok: ooxmlPackageOk({
      missing,
      documentLint,
      findings,
      malformedXml,
      contentTypes,
      relationships,
      baseline,
      redlining,
    }),
    format,
    entries: entries.length,
    missing,
    unsafeEntries: findings.unsafeEntries,
    macros: findings.macros,
    security: {
      macros: findings.macros,
      signatures: findings.signatures,
      externalLinks: findings.externalLinks,
      dataConnections: findings.dataConnections,
      embeddedObjects: findings.embeddedObjects,
      macroExecution: 'disabled',
      digitalSignatureInvalidated: baseline.digitalSignatureInvalidated === true,
    },
    malformedXml,
    missingRelationships: relationships.missingRelationships,
    duplicateRelationshipIds: relationships.duplicateRelationshipIds,
    externalRelationships: relationships.externalRelationships,
    ...contentTypes,
    baseline,
    redlining,
    documentLint,
    validation: 'opc-relationships-content-types-xml',
  };
}
