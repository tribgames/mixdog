import {
  Children,
  cloneElement,
  createContext,
  Fragment,
  isValidElement,
  memo,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';

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
function useUnitParking(parking: BlockParking | null, id: string, node: MarkdownAstChild, held: boolean): void {
  const measured = useRef(node);
  useLayoutEffect(() => {
    if (measured.current !== node) parking?.release(id);
    measured.current = node;
  });
  useLayoutEffect(() => {
    if (!parking || !held) return;
    parking.hold(id, true);
    return () => parking.hold(id, false);
  }, [parking, id, held]);
  // The unit left the reply, and nothing is kept for its code blocks. They
  // leave in the commit's layout phase, which this cleanup comes after.
  useEffect(() => () => parking?.release(id), [parking, id]);
}

function UnitBody({ unit, node, scope }: { unit: MarkdownUnit; node: MarkdownAstChild; scope: DocumentScope }) {
  const root = useMemo(() => ({ type: 'root', children: [node] }) as MarkdownAstRoot, [node]);
  const { parking } = scope;
  const rendered = useMarkdownAst(
    root,
    scope.copyControl,
    { timeline: scope.fadeTimeline, offset: unit.base, from: unit.from, end: unit.end },
    parking ? unit.key : null
  );
  useUnitParking(parking, unit.key, node, unit.held);
  if (!parking || !isValidElement<{ children?: ReactNode }>(rendered) || rendered.type !== Fragment) return rendered;
  const [child] = Children.toArray(rendered.props.children);
  if (!isValidElement(child)) return child;
  // A block far from the reader can leave the DOM (markdown-block-parking).
  return (
    <MarkdownBlock id={unit.key} parking={parking}>
      {cloneElement(child as ReactElement<Record<string, unknown>>, { [UNIT_ATTRIBUTE]: unit.key })}
    </MarkdownBlock>
  );
}

/** Text whose parse is still to land: fenced code shows as source, which
 *  holds its place; the rest shows nothing. */
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
  if (!containsFencedCodeMarkdown(text)) return marker;
  return (
    <>
      <MarkdownSourceFallback text={text} copyControl={copyControl} />
      {marker}
    </>
  );
}

const MarkdownDocumentUnit = memo(function MarkdownDocumentUnit({ unit }: { unit: MarkdownUnit }) {
  const scope = useContext(DocumentScopeContext) as DocumentScope;
  if (!unit.node) {
    return <UnitWaiting text={unit.text ?? ''} pending={unit.pending ?? false} copyControl={scope.copyControl} />;
  }
  return <UnitBody unit={unit} node={unit.node} scope={scope} />;
});

/** A page adds no element: its units are children of the reply's element. */
function PageItems({ page }: { page: MarkdownPage }) {
  return page.items.map((item) =>
    isMarkdownPage(item) ? (
      <MarkdownDocumentPage key={item.key} page={item} />
    ) : (
      <MarkdownDocumentUnit key={item.key} unit={item} />
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
