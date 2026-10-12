// YAML (`---`) or TOML (`+++`) metadata block at the very top of a document.
const FRONT_MATTER = /^(---|\+\+\+)[ \t]*\r?\n(?:[\s\S]*?\r?\n)?\1[ \t]*(?:\r?\n|$)/;

export interface FrontMatterSplit {
  /** The exact source bytes of the block, delimiters and trailing EOL included ('' when absent). */
  frontMatter: string;
  /** Everything after the block, untouched. */
  body: string;
}

/** Splits a document into its front matter and body. Joining the two parts
 *  always reproduces the input byte for byte. */
export function splitFrontMatter(text: string): FrontMatterSplit {
  const match = FRONT_MATTER.exec(text);
  if (!match) return { frontMatter: '', body: text };
  return { frontMatter: match[0], body: text.slice(match[0].length) };
}

/** The block's inner lines without its delimiters, for the read-only banner. */
export function frontMatterLines(frontMatter: string): string[] {
  const lines = frontMatter.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  return lines.slice(1, -1);
}
