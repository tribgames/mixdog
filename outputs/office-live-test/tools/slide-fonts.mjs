// Prints each text shape of one slide with the typefaces its runs name: node slide-fonts.mjs <deck.pptx> <slide>
import JSZip from 'jszip';
import { readFileSync } from 'node:fs';

const [file, slide] = process.argv.slice(2);
const zip = await JSZip.loadAsync(readFileSync(file));
const xml = await zip.file(`ppt/slides/slide${slide}.xml`).async('string');
for (const shape of xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || []) {
  const text = [...shape.matchAll(/<a:t>([^<]*)/g)].map((m) => m[1]).join('');
  if (!text) continue;
  const faces = [...new Set([...shape.matchAll(/<a:(latin|ea|cs) typeface="([^"]*)"/g)].map((m) => `${m[1]}=${m[2]}`))];
  console.log(JSON.stringify(text.slice(0, 30)), faces.join(' ') || '(theme)');
}
