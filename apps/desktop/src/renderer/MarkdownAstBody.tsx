import { Fragment, memo, type ReactNode } from 'react';
import { jsx, jsxs } from 'react/jsx-runtime';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';

import type { MarkdownAstRoot } from './markdown-ast';
import { markdownComponents, type MarkdownCopyControl } from './markdown-components';

// A streamed token re-renders the owner while the same parse stays on screen;
// only a newly landed AST rebuilds the element tree.
export default memo(function MarkdownAstBody({
  root,
  copyControl,
}: {
  root: MarkdownAstRoot;
  copyControl: MarkdownCopyControl;
}) {
  return toJsxRuntime(root as never, {
    Fragment,
    jsx,
    jsxs,
    components: markdownComponents(copyControl) as never,
    ignoreInvalidStyle: true,
    passKeys: true,
  }) as ReactNode;
});
