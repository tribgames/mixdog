// Records the CMaps of pdf.js 6.4.299 for tests/fontfile_cmap_truetype.rs: what CMapFactory makes of every predefined
// packed CMap and of a set of embedded CMap texts, and where readCharCode reads codes. Usage:
//   node record_cmaps.mjs <pdfjs-dist folder> <output file>
// The folder is the pdfjs-dist 6.4.299 of the reference tree (read only). The load hook appends exports to the worker
// module in memory; no byte of the tree changes.
import { readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , pdfjsDir, outFile] = process.argv;
if (!pdfjsDir || !outFile) throw new Error('usage: node record_cmaps.mjs <pdfjs-dist folder> <output file>');

registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    if (!url.endsWith('/pdf.worker.mjs')) return loaded;
    return {
      ...loaded,
      source: `${loaded.source}\nexport { BUILT_IN_CMAPS, CMapFactory, IdentityCMap, Name, Stream };\n`,
    };
  },
});
const worker = await import(pathToFileURL(join(pdfjsDir, 'legacy/build/pdf.worker.mjs')).href);
const { BUILT_IN_CMAPS, CMapFactory, IdentityCMap, Name, Stream } = worker;

const fetchBuiltInCMap = async (name) => ({
  cMapData: new Uint8Array(readFileSync(join(pdfjsDir, 'cmaps', `${name}.bcmap`))),
  isCompressed: true,
});

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const repr = (value) => {
  if (typeof value === 'number') return `c${value}`;
  // A /Name inside a bfrange array is kept by pdf.js as an object that is neither a number nor a string.
  if (typeof value !== 'string') return 'o';
  return `s${[...value].map((ch) => ch.charCodeAt(0).toString(16)).join('.')}`;
};
const fnv = (text) => {
  let h = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(text, 'utf8')) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
};

const lines = [];
const describe = (cmap) => {
  lines.push(`v ${cmap.vertical ? 1 : 0}`);
  lines.push(`n ${cmap.name || '-'}`);
  cmap.codespaceRanges.forEach((ranges, i) => {
    for (let k = 0; k < ranges.length; k += 2) lines.push(`cs ${i + 1} ${ranges[k]} ${ranges[k + 1]}`);
  });
};

// Predefined CMaps: the whole map is checked through a hash of its entries in order, and sixteen entries are listed.
for (const name of [...BUILT_IN_CMAPS].sort()) {
  const cmap = await CMapFactory.create({ encoding: Name.get(name), fetchBuiltInCMap, useCMap: null });
  lines.push(`predef ${name}`);
  describe(cmap);
  lines.push(`size ${cmap.size}`);
  const entries = [];
  cmap.forEach((code, value) => entries.push(`${code}=${repr(value)};`));
  lines.push(`hash ${fnv(entries.join(''))}`);
  const step = Math.max(1, Math.floor(entries.length / 16));
  for (let i = 0; i < entries.length; i += step) {
    const [code, value] = entries[i].slice(0, -1).split('=');
    lines.push(`m ${code} ${value}`);
  }
  lines.push('end');
}

const text = (s) => Buffer.from(s, 'latin1');
const CASES = {
  'to-unicode': `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
/CMapName /Adobe-Identity-UCS def /CMapType 2 def
1 begincodespacerange <0000> <FFFF> endcodespacerange
2 beginbfchar <0003> <0020> <0010> <D835DC00> endbfchar
2 beginbfrange <0020> <0022> <0041> <0030> <0032> [<0061> <0062> <0063>] endbfrange
endcmap CMapName currentdict /CMap defineresource pop end end`,
  'cid-cmap-vertical': `/CMapName /Test-V def /WMode 1 def
2 begincodespacerange <00> <80> <8140> <FEFE> endcodespacerange
2 begincidrange <20> <7e> 1 <8140> <817e> 633 endcidrange
2 begincidchar <80> 99 <8180> 700 endcidchar
2 beginnotdefrange <00> <1f> 1 <80> <80> 1 endnotdefrange`,
  'bfrange-carry': `1 begincodespacerange <00> <ff> endcodespacerange
2 beginbfrange <00> <03> <00FE> <10> <12> <FF> endbfrange
1 beginbfrange <20> <21> 65 endbfrange
1 beginbfrange <30> <31> <D83D> endbfrange`,
  'bfrange-array-short': `1 beginbfrange <00> <05> [<0041> <0042> 7 /Foo] endbfrange`,
  'bfchar-over-bfrange': `1 beginbfrange <00> <04> <0041> endbfrange
2 beginbfchar <02> <005A> <09> <0058> endbfchar`,
  'usecmap-builtin': `/Adobe-Japan1-UCS2 usecmap
1 begincidrange <0001> <0003> 9000 endcidrange`,
  'usecmap-builtin-codespace': `/UniJIS-UCS2-H usecmap
1 begincidchar <0020> 7 endcidchar`,
  'usecmap-identity': `/Identity-H usecmap
1 begincidchar <0041> 5 endcidchar`,
  'usecmap-unknown': `/NoSuchCMap usecmap
1 begincidchar <0041> 5 endcidchar`,
  'malformed-codespace': `1 begincodespacerange <00> 5 endcodespacerange
1 beginbfchar <01> <0041> endbfchar`,
  'malformed-bfrange': `1 beginbfrange <00> <01> /Name endbfrange
1 beginbfchar <01> <0042> endbfchar`,
  'malformed-cidrange': `1 begincidrange <00> <01> (x) endcidrange
1 begincidchar <01> 4 endcidchar`,
  'bfchar-needs-strings': `2 beginbfchar 5 <0041> <02> <0042> endbfchar`,
  'codespace-widths': `4 begincodespacerange <00> <7f> <8000> <80ff> <810000> <81ffff> <82000000> <82ffffff> endcodespacerange`,
  'codespace-five-bytes': `1 begincodespacerange <0000000000> <ffffffffff> endcodespacerange
1 begincidchar <00> 1 endcidchar`,
  'budget-exceeded': `1 begincidrange <00000000> <00ffffff> 0 endcidrange
1 begincidchar <01> 4 endcidchar`,
  'empty': '',
  'identity-by-range': `/CMapName /Identity-H def
1 begincodespacerange <0000> <FFFF> endcodespacerange
1 begincidrange <0000> <FFFF> 0 endcidrange`,
  'identity-v-by-range': `/CMapName /Identity-V def /WMode 1 def
1 begincodespacerange <0000> <FFFF> endcodespacerange
1 begincidrange <0000> <FFFF> 0 endcidrange`,
  'name-not-identity': `/CMapName /Identity-H def
1 begincodespacerange <0000> <FFFF> endcodespacerange
1 begincidrange <0000> <FFFE> 0 endcidrange`,
  'endcmap-stops': `1 begincidchar <01> 1 endcidchar endcmap
1 begincidchar <02> 2 endcidchar`,
  'comments-and-names': `% a comment
/CMapName /Named def /WMode 0 def /WMode 1 def
1 begincidchar <01> 1 endcidchar`,
  'duplicate-codes-keep-first-place': `3 begincidchar <01> 1 <02> 2 <01> 3 endcidchar`,
  'bfchar-empty-string': `1 beginbfchar <01> <> endbfchar`,
  'unterminated-bfrange': `1 beginbfrange <00> <01> <0041>`,
};

for (const [name, source] of Object.entries(CASES)) {
  const bytes = text(source);
  lines.push(`case ${name} ${hex(bytes) || '-'}`);
  try {
    const cmap = await CMapFactory.create({ encoding: new Stream(bytes), fetchBuiltInCMap, useCMap: null });
    if (cmap instanceof IdentityCMap) {
      lines.push('kind identity');
      lines.push(`v ${cmap.vertical ? 1 : 0}`);
      lines.push('end');
      continue;
    }
    lines.push('kind map');
    describe(cmap);
    lines.push(`size ${cmap.size}`);
    let count = 0;
    cmap.forEach((code, value) => {
      if (count++ < 60) lines.push(`m ${code} ${repr(value)}`);
    });
    // readCharCode over a few strings, as the evaluator calls it.
    for (const probe of ['00', '41', '8140', '80', '81aabb', '82010203', '00000000', 'ffffffff', '', '7f80', '810000ff']) {
      const probeBytes = Buffer.from(probe, 'hex');
      const str = probeBytes.toString('latin1');
      for (let offset = 0; offset <= Math.min(1, str.length); offset++) {
        const out = {};
        cmap.readCharCode(str, offset, out);
        lines.push(`rc ${probe || '-'} ${offset} ${out.charcode} ${out.length}`);
      }
    }
    lines.push('end');
  } catch (error) {
    lines.push(`error ${String(error?.message ?? error).replace(/\s+/g, '_')}`);
    lines.push('end');
  }
}

writeFileSync(outFile, `${lines.join('\n')}\n`, 'utf8');
console.log(`${lines.length} lines`);
