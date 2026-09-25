// Prints the XML around a phrase in one package part: node part-grep.mjs <file> <part> <phrase> [before] [after]
import JSZip from 'jszip';
import { readFileSync } from 'node:fs';

const [file, part, phrase, before = 900, after = 80] = process.argv.slice(2);
const xml = await (await JSZip.loadAsync(readFileSync(file))).file(part).async('string');
const at = xml.indexOf(phrase);
console.log(at < 0 ? `(not found in ${part})` : xml.slice(Math.max(0, at - Number(before)), at + Number(after)));
