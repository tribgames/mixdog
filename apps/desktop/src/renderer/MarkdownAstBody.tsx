import { Fragment, memo, type ReactNode, useContext, useMemo } from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';

import type { MarkdownAstRoot } from './markdown-ast';
import { PLACE_PROP } from './markdown-block-parking';
import { highlightMentions, MarkdownMentionNamesContext } from './markdown-mentions';
import { markdownComponents, type MarkdownCopyControl } from './markdown-components';

/** `root` as React elements. `place`: where the tree is in a reply whose
 *  blocks park (null: they do not): each code block is told its place under
 *  it, under which what is parked of its lines is kept while the block around
 *  it is out of the DOM (markdown-code-lines). */
export function useMarkdownAst(
  root: MarkdownAstRoot,
  copyControl: MarkdownCopyControl,
  place: string | null
): ReactNode {
  const mentionNames = useContext(MarkdownMentionNamesContext);
  const body = useMemo(() => (mentionNames ? highlightMentions(root, mentionNames) : root), [root, mentionNames]);
  const components = markdownComponents(copyControl);
  let codes = 0;
  const placed =
    (create: typeof jsx): typeof jsx =>
    (type, props, key) =>
      create(
        type,
        type === components.pre ? { ...(props as object), [PLACE_PROP]: `${place}/${codes++}` } : props,
        key
      );
  return toJsxRuntime(body as never, {
    Fragment,
    jsx: place === null ? jsx : placed(jsx),
    jsxs: place === null ? jsxs : placed(jsxs),
    components: components as never,
    ignoreInvalidStyle: true,
    passKeys: true,
  }) as ReactNode;
}

// A streamed token re-renders the owner while the same parse stays on screen;
// only a newly landed AST rebuilds the element tree.
export default memo(function MarkdownAstBody({
  root,
  copyControl,
}: {
  root: MarkdownAstRoot;
  copyControl: MarkdownCopyControl;
}) {
  return useMarkdownAst(root, copyControl, null);
});
