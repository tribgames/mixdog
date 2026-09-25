// Prints the colour, shading, and highlight of each run in body paragraph n: node docx-para-runs.mjs <file.docx> <n>
import JSZip from 'jszip';
import { readFileSync } from 'node:fs';

const [file, n] = process.argv.slice(2);
const xml = await (await JSZip.loadAsync(readFileSync(file))).file('word/document.xml').async('string');
const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)[1];
const paragraphs = [];
let depth = 0;
for (const match of body.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>|<w:tbl>[\s\S]*?<\/w:tbl>/g)) {
  if (match[0].startsWith('<w:tbl')) continue;
  paragraphs.push(match[0]);
}
void depth;
const paragraph = paragraphs[Number(n) - 1] || '';
for (const run of paragraph.matchAll(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g)) {
  const text = [...run[1].matchAll(/<w:t[^>]*>([^<]*)/g)].map((m) => m[1]).join('');
  const props = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(run[1])?.[1] || '';
  const bits = [...props.matchAll(/<w:(color|shd|highlight)\b([^>]*)\/>/g)].map((m) => `${m[1]}${m[2]}`);
  if (text.trim()) console.log(JSON.stringify(text), bits.join(' | '));
}
