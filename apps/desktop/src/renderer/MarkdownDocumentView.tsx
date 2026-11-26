import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef } from 'react';

import type { MarkdownAstRoot } from './markdown-ast';
import { useMarkdownAst } from './MarkdownAstBody';
import { MarkdownBlock } from './markdown-block';
import { type BlockParking, MarkdownBlockParkingContext, UNIT_ATTRIBUTE } from './markdown-block-parking';
import type { MarkdownCopyControl } from './markdown-components';
import { isMarkdownPage, type MarkdownAstChild, type MarkdownPage, type MarkdownUnit } from './markdown-document';
import type { StreamFadeTimeline } from './markdown-stream-fade';
import { containsFencedCodeMarkdown, MarkdownSourceFallback } from './MarkdownSourceFallback';

interface DocumentScope {
  fadeTimeline: StreamFadeTimeline | null;
  copyControl: MarkdownCopyControl;
  parking: BlockParking | null;
}

// Stays the same object while the reply streams: a new value would reach
// every unit.
const DocumentScopeContext = createContext<DocumentScope | null>(null);

/** Parking knows the unit by its key: the box it measured for it goes when
 *  the unit shows another node, and while the reply grows a held unit stays. */
function useUnitParking(
  parking: BlockParking | null,
  id: string | null,
  node: MarkdownAstChild | null,
  held: boolean
): void {
  const measured = useRef(node);
  useLayoutEffect(() => {
    if (id && measured.current !== node) parking?.release(id);
    measured.current = node;
  });
  useLayoutEffect(() => {
    if (!parking || !id || !held) return;
    parking.hold(id, true);
    return () => parking.hold(id, false);
  }, [parking, id, held]);
  // The unit left the reply, and nothing is kept for its code blocks. They
  // leave in the commit's layout phase, which this cleanup comes after.
  useEffect(
    () => () => {
      if (id) parking?.release(id);
    },
    [parking, id]
  );
}

function UnitBody({ unit, node, scope }: { unit: MarkdownUnit; node: MarkdownAstChild; scope: DocumentScope }) {
  const root = useMemo(() => ({ type: 'root', children: [node] }) as MarkdownAstRoot, [node]);
  return useMarkdownAst(
    root,
    scope.copyControl,
    { timeline: scope.fadeTimeline, offset: unit.base, from: unit.from, end: unit.end },
    scope.parking ? unit.key : null
  );
}

/** Text whose parse is still to land: fenced code shows as source and prose
 *  shows as a height-preserving plain-text fallback while the async parse settles. */
function UnitWaiting({
  text,
  pending,
  copyControl,
}: {
  text: string;
  pending: boolean;
  copyControl: MarkdownCopyControl;
}) {
  const marker = pending ? <span hidden data-transcript-pending /> : null;
  if (!text.trim()) return marker;
  if (!containsFencedCodeMarkdown(text)) {
    // The blank lines around a block are no lines of it once parsed: kept under `pre-wrap` they drew it a line taller.
    return (
      <p className="markdown-plain">
        {text.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd()}
        {marker}
      </p>
    );
  }
  return (
    <>
      <MarkdownSourceFallback text={text} copyControl={copyControl} />
      {marker}
    </>
  );
}

const MarkdownDocumentUnit = memo(function MarkdownDocumentUnit({ unit }: { unit: MarkdownUnit }) {
  const scope = useContext(DocumentScopeContext) as DocumentScope;
  const lastBody = useRef<MarkdownUnit | null>(null);
  const lastWaitingText = useRef('');
  if (unit.node) lastBody.current = unit;
  const bodyUnit = lastBody.current;
  const bodyNode = bodyUnit?.node ?? null;
  const text = unit.text ?? '';
  if (!bodyUnit && text.trim()) lastWaitingText.current = text;
  let shownText = text;
  if (!text.trim() && unit.pending) shownText = lastWaitingText.current;
  const { parking } = scope;
  const parkingId = bodyUnit ? bodyUnit.key : null;
  useUnitParking(parking, parkingId, bodyNode, bodyUnit?.held ?? false);
  // The line breaks a whole parse keeps between blocks are no block: no element of their own, as in a reply read whole,
  // and no box beside a block that parks.
  if (bodyUnit && bodyNode && bodyNode.type !== 'element') {
    return <UnitBody unit={bodyUnit} node={bodyNode} scope={scope} />;
  }
  const empty = !bodyNode && !shownText.trim();
  const pendingAfterBody = !unit.node && unit.pending ? <span hidden data-transcript-pending /> : null;
  const outer = (
    <div
      className="markdown-unit"
      hidden={empty || undefined}
      {...(parking && parkingId ? { [UNIT_ATTRIBUTE]: parkingId } : undefined)}
    >
      {bodyUnit && bodyNode ? (
        <>
          <UnitBody unit={bodyUnit} node={bodyNode} scope={scope} />
          {pendingAfterBody}
        </>
      ) : (
        <UnitWaiting text={shownText} pending={unit.pending ?? false} copyControl={scope.copyControl} />
      )}
    </div>
  );
  if (!parking) return outer;
  // A block far from the reader can leave the DOM (markdown-block-parking).
  return (
    <MarkdownBlock id={parkingId ?? unit.key} parking={parking}>
      {outer}
    </MarkdownBlock>
  );
});

/** A page adds no element: its units are children of the reply's element. */
function PageItems({ page }: { page: MarkdownPage }) {
  return page.items.map((item) =>
    isMarkdownPage(item) ? (
      <MarkdownDocumentPage key={item.key} page={item} />
    ) : (
      <MarkdownDocumentUnit key={item.slotKey ?? item.key} unit={item} />
    )
  );
}

// Its own pages are this memo too: one page that changes renders alone.
const MarkdownDocumentPage = memo(PageItems);

/** A reply's pages (markdown-document), live or finished alike. */
export function MarkdownDocumentView({
  root,
  fadeTimeline,
  copyControl,
}: {
  root: MarkdownPage;
  fadeTimeline: StreamFadeTimeline | null;
  copyControl: MarkdownCopyControl;
}) {
  const parking = useContext(MarkdownBlockParkingContext);
  const scope = useMemo(() => ({ fadeTimeline, copyControl, parking }), [fadeTimeline, copyControl, parking]);
  return (
    <DocumentScopeContext.Provider value={scope}>
      <MarkdownDocumentPage page={root} />
    </DocumentScopeContext.Provider>
  );
}
