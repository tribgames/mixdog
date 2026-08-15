// Lazy-loaded markdown pipeline. react-markdown + remark-gfm pull the whole
// unified/remark/rehype ecosystem into whatever chunk imports them; keeping
// this file behind React.lazy removes that weight from the main bundle. The
// transcript's `.markdown` wrapper stays in App.tsx so DOM structure and
// static CSS assertions are unaffected while this chunk streams in.
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";

import { markdownComponents, type MarkdownCopyControl } from "./markdown-components";
import {
  repairAdjacentStrongPunctuation,
  trimTrailingCodeNewline,
} from "./markdown-plugins";

export default function MarkdownBody({ text, copyControl }: {
  text: string;
  copyControl: MarkdownCopyControl;
}) {
  // singleTilde:false — GFM's single-tilde strikethrough turns ordinary range
  // notation ("1~2개 ... 3~4개") into struck-through spans; only ~~x~~ counts.
  // singleDollarTextMath:false — shell/price prose ("$PATH and $5") must never
  // flip into inline math; only explicit $$…$$ math is intentional enough.
  return <ReactMarkdown
    remarkPlugins={[
      repairAdjacentStrongPunctuation,
      [remarkGfm, { singleTilde: false }],
      [remarkMath, { singleDollarTextMath: false }],
    ]}
    rehypePlugins={[rehypeKatex, rehypeHighlight, trimTrailingCodeNewline]}
    components={markdownComponents(copyControl) as Components}
  >{text}</ReactMarkdown>;
}
