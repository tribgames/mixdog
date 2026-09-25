// Prints each text shape of one slide with its run sizes: node slide-sizes.mjs <deck.pptx> <slide>
import JSZip from 'jszip';
import { readFileSync } from 'node:fs';

const [file, slide] = process.argv.slice(2);
const xml = await (await JSZip.loadAsync(readFileSync(file))).file(`ppt/slides/slide${slide}.xml`).async('string');
for (const shape of xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || []) {
  const text = [...shape.matchAll(/<a:t>([^<]*)/g)].map((m) => m[1]).join('');
  if (!text) continue;
  const sizes = [...new Set([...shape.matchAll(/\bsz="(\d+)"/g)].map((m) => Number(m[1]) / 100))];
  console.log(JSON.stringify(text.slice(0, 24)), sizes.join(','));
}
