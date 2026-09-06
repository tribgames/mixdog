// The device kit an authoring script composes with: the ```js blocks of the
// pptx skill's kit.md, charts.md, and pictures.md, read once and run before the
// script. The skill files stay the single source — the model reads them for the
// signatures, the runner runs the same code — so a script holds the brief, one
// deck() call, and the slides, never a pasted toolbox. A later function
// declaration in the script overrides the kit's (declarations hoist; the last wins).
import { readFileSync } from 'node:fs';

const REFERENCES = new URL('../../../defaults/skills/pptx/references/', import.meta.url);
const KIT_FILES = ['kit.md', 'charts.md', 'pictures.md'];
const BLOCK = /```js\n([\s\S]*?)```/g;

let prelude = null;

export function kitBlocks(file) {
  const text = readFileSync(new URL(file, REFERENCES), 'utf8');
  return [...text.matchAll(BLOCK)].map((match) => match[1]).join('\n');
}

export function kitPrelude() {
  if (prelude === null) {
    const source = KIT_FILES.map((file) => kitBlocks(file)).join('\n');
    prelude = { source, lines: source.split('\n').length };
  }
  return prelude;
}

// A script that creates its own presentation (`const pres = …`) or pastes the
// kit (`function palette(`) brings its own toolbox and runs as written.
export function scriptCarriesKit(script) {
  const source = String(script || '');
  return /\b(?:const|let|var)\s+(?:pres|pptxgen)\b/.test(source) || /\bfunction\s+palette\s*\(/.test(source);
}
