import {
  PDFDict,
  PDFHexString,
  PDFName,
  PDFString,
} from 'pdf-lib';

const WEB_LINK_SCHEMES = /^(https?|mailto|tel):/i;
const ACTIVE_ACTIONS = new Set(['JavaScript', 'Launch', 'GoToR', 'GoToE', 'ImportData', 'SubmitForm']);

// Actions a viewer would run on open or click — JavaScript, launching a
// program, reaching another file, or a link on a non-web scheme — are the
// part of an untrusted PDF worth naming. They are reported, never followed.
export function activeContentIssues(document) {
  const issues = [];
  const { context, catalog } = document;
  const nameOf = (value) => (value instanceof PDFName ? value.decodeText() : null);
  const describeAction = (dict) => {
    const kind = nameOf(dict.get(PDFName.of('S')));
    if (!kind) return null;
    if (ACTIVE_ACTIONS.has(kind)) return `a ${kind} action`;
    if (kind !== 'URI') return null;
    const uri = context.lookup(dict.get(PDFName.of('URI')));
    const text = uri instanceof PDFString || uri instanceof PDFHexString ? uri.decodeText().trim() : '';
    return WEB_LINK_SCHEMES.test(text) ? null : `a link to ${text.slice(0, 80) || 'an empty target'}`;
  };
  const report = (path, what) => issues.push({
    severity: 'warning',
    code: 'active_content',
    path,
    message: `${what}; treat the file as untrusted and do not open it in a viewer that honours actions.`,
  });
  const opening = context.lookupMaybe(catalog.get(PDFName.of('OpenAction')), PDFDict);
  const openingKind = opening ? describeAction(opening) : null;
  if (openingKind) report('/metadata', `The document runs ${openingKind} when opened`);
  if (catalog.has(PDFName.of('AA'))) report('/metadata', 'The document declares additional actions (AA) that run on events');
  const names = context.lookupMaybe(catalog.get(PDFName.of('Names')), PDFDict);
  if (names?.has(PDFName.of('JavaScript'))) report('/metadata', 'The document carries document-level JavaScript');
  document.getPages().forEach((page, index) => {
    const annotations = page.node.Annots();
    if (!annotations) return;
    for (const ref of annotations.asArray()) {
      const annotation = context.lookupMaybe(ref, PDFDict);
      const action = annotation ? context.lookupMaybe(annotation.get(PDFName.of('A')), PDFDict) : null;
      const kind = action ? describeAction(action) : null;
      if (kind) report(`/page[${index + 1}]`, `An annotation on page ${index + 1} triggers ${kind}`);
    }
  });
  return issues;
}
