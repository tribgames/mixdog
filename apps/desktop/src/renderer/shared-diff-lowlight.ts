import { getSharedLowlight } from './shared-lowlight';
import { resolveBasenameHighlightLanguage, resolveDiffHighlightLanguage } from './shared-lowlight-extra';

interface DiffSyntaxNode {
  type: string;
  value: string;
  startIndex: number;
  endIndex: number;
  lineNumber: number;
  properties?: { className?: string[]; [key: string]: unknown };
  children?: DiffSyntaxNode[];
}

interface DiffAstNode {
  type: string;
  value?: string;
  startIndex?: number;
  endIndex?: number;
  lineNumber?: number;
  properties?: { className?: string[]; [key: string]: unknown };
  children?: DiffAstNode[];
}

interface DiffSyntaxLine {
  value: string;
  lineNumber: number;
  valueLength: number;
  nodeList: Array<{ node: DiffSyntaxNode; wrapper?: DiffSyntaxNode }>;
}

export function processAST(ast: { children?: DiffAstNode[] }): {
  syntaxFileObject: Record<number, DiffSyntaxLine>;
  syntaxFileLineNumber: number;
} {
  let lineNumber = 1;
  const syntaxObj: Record<number, DiffSyntaxLine> = {};
  const appendSegment = (line: number, segment: DiffAstNode, wrapper?: DiffAstNode) => {
    const value = segment.value ?? '';
    const length = value.length;
    const existing = syntaxObj[line];
    segment.lineNumber = line;
    const syntaxNode = segment as DiffSyntaxNode;
    const syntaxWrapper = wrapper as DiffSyntaxNode | undefined;
    if (!existing) {
      syntaxNode.startIndex = 0;
      syntaxNode.endIndex = length - 1;
      syntaxObj[line] = {
        value,
        lineNumber: line,
        valueLength: length,
        nodeList: [{ node: syntaxNode, wrapper: syntaxWrapper }],
      };
    } else {
      syntaxNode.startIndex = existing.valueLength;
      syntaxNode.endIndex = syntaxNode.startIndex + length - 1;
      existing.value += value;
      existing.valueLength += length;
      existing.nodeList.push({ node: syntaxNode, wrapper: syntaxWrapper });
    }
  };
  const walk = (nodes: DiffAstNode[], wrapper?: DiffAstNode) => {
    for (const node of nodes) {
      if (node.type === 'text') {
        const text = node.value ?? '';
        if (!text.includes('\n')) {
          appendSegment(lineNumber, node, wrapper);
          continue;
        }
        const parts = text.split('\n');
        node.children = node.children || [];
        for (let index = 0; index < parts.length; index += 1) {
          const segmentText = index === parts.length - 1 ? parts[index] : `${parts[index]}\n`;
          const targetLine = index === 0 ? lineNumber : ++lineNumber;
          const segmentNode: DiffAstNode = {
            type: 'text',
            value: segmentText,
            startIndex: Number.POSITIVE_INFINITY,
            endIndex: Number.POSITIVE_INFINITY,
            lineNumber: targetLine,
          };
          appendSegment(targetLine, segmentNode, wrapper);
          node.children.push(segmentNode);
        }
        node.lineNumber = lineNumber;
        continue;
      }
      if (Array.isArray(node.children)) {
        walk(node.children, node);
        node.lineNumber = lineNumber;
      }
    }
  };
  if (Array.isArray(ast?.children)) walk(ast.children);
  return { syntaxFileObject: syntaxObj, syntaxFileLineNumber: lineNumber };
}

export function _getAST(): Record<string, never> {
  return {};
}

let maxLineToIgnoreSyntax = 2000;
const ignoreSyntaxHighlightList: Array<string | RegExp> = [];

export const sharedDiffHighlighter = {
  name: 'lowlight',
  type: 'class' as const,
  get maxLineToIgnoreSyntax() {
    return maxLineToIgnoreSyntax;
  },
  setMaxLineToIgnoreSyntax(value: number) {
    maxLineToIgnoreSyntax = value;
  },
  get ignoreSyntaxHighlightList() {
    return ignoreSyntaxHighlightList;
  },
  setIgnoreSyntaxHighlightList(list: Array<string | RegExp>) {
    ignoreSyntaxHighlightList.length = 0;
    ignoreSyntaxHighlightList.push(...list);
  },
  getAST(raw: string, fileName?: string, lang?: string): ReturnType<ReturnType<typeof getSharedLowlight>['highlight']> {
    if (
      fileName &&
      ignoreSyntaxHighlightList.some((item) => (item instanceof RegExp ? item.test(fileName) : fileName === item))
    ) {
      return undefined as unknown as ReturnType<ReturnType<typeof getSharedLowlight>['highlight']>;
    }
    const lowlight = getSharedLowlight();
    const basenameLang = resolveBasenameHighlightLanguage(fileName);
    if (basenameLang && lowlight.registered(basenameLang)) {
      return lowlight.highlight(basenameLang, raw);
    }
    if (lang && lowlight.registered(lang)) {
      return lowlight.highlight(lang, raw);
    }
    const resolved = resolveDiffHighlightLanguage(lang, fileName);
    if (resolved && lowlight.registered(resolved)) {
      return lowlight.highlight(resolved, raw);
    }
    return undefined as unknown as ReturnType<ReturnType<typeof getSharedLowlight>['highlight']>;
  },
  processAST,
  hasRegisteredCurrentLang(lang: string) {
    const lowlight = getSharedLowlight();
    if (lowlight.registered(lang)) return true;
    const resolved = resolveDiffHighlightLanguage(lang, lang);
    return resolved !== null && lowlight.registered(resolved);
  },
  getHighlighterEngine() {
    return getSharedLowlight();
  },
};

/** Returns a highlighter handle with a bumped name so `@git-diff-view` re-runs `initSyntax` after a lazy grammar loads. */
export function createVersionedDiffHighlighter(version: number): typeof sharedDiffHighlighter {
  if (version <= 0) return sharedDiffHighlighter;
  return {
    ...sharedDiffHighlighter,
    name: `lowlight-v${version}`,
    get maxLineToIgnoreSyntax() {
      return sharedDiffHighlighter.maxLineToIgnoreSyntax;
    },
    get ignoreSyntaxHighlightList() {
      return sharedDiffHighlighter.ignoreSyntaxHighlightList;
    },
  };
}

export const highlighter = sharedDiffHighlighter;
export const versions = '0.1.8';
