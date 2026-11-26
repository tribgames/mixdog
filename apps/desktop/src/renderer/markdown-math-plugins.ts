import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import { ensureKatexTextMetrics } from './katex-text-metrics';

interface MathSyntaxNode {
  type?: string;
  value?: unknown;
  properties?: unknown;
  children?: MathSyntaxNode[];
}

const MATH_CLASS = /^(?:language-math|math-inline|math-display)$/;

function isMathNode(node: MathSyntaxNode): boolean {
  const className = (node.properties as { className?: unknown } | undefined)?.className;
  return Array.isArray(className) && className.some((name) => MATH_CLASS.test(String(name)));
}

function mathSource(node: MathSyntaxNode): string {
  if (node.type === 'text') return String(node.value ?? '');
  return Array.isArray(node.children) ? node.children.map(mathSource).join('') : '';
}

// KaTeX lends characters it has no metrics for (CJK, …) the metrics of 'M',
// which lets their ink cross a fraction bar. Hand it the measured metrics of
// the math sources' characters before rehype-katex lays them out.
export function measureKatexTextGlyphs() {
  return (tree: MathSyntaxNode) => {
    const visit = (parent: MathSyntaxNode) => {
      if (!Array.isArray(parent.children)) return;
      for (const child of parent.children) {
        if (isMathNode(child)) ensureKatexTextMetrics(mathSource(child));
        else visit(child);
      }
    };
    visit(tree);
  };
}

export { rehypeKatex, remarkMath };
