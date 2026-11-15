// Usage: node svg-thin.mjs <original-Node-tree> <output.png>
// Inspection/reference recording only; no system fonts or user profile inputs.
process.env.DISABLE_SYSTEM_FONTS_LOAD = '1';
const { createRequire } = await import('node:module');
const { resolve, join } = await import('node:path');
const { writeFile } = await import('node:fs/promises');
const { createHash } = await import('node:crypto');
const [tree, output] = process.argv.slice(2);
if (!tree || !output) throw new Error('original tree and explicit output PNG required');
const sharp = createRequire(join(resolve(tree), 'package.json'))('sharp');
let paths = '';
for (let x = -120; x <= 120; x += 4) paths += `<path d="M${x} 0L${x + 128} 128"/>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="white"/><g fill="none" stroke="black" stroke-width="0.05">${paths}</g></svg>`;
const png = await sharp(Buffer.from(svg), { density: 72 }).png().toBuffer();
await writeFile(output, png);
console.log(JSON.stringify({ versions: sharp.versions, inputSha256: createHash('sha256').update(svg).digest('hex'), pngSha256: createHash('sha256').update(png).digest('hex') }));
