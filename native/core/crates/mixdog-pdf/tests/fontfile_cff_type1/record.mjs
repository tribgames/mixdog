// Records the twin cases of tests/fontfile_cff_type1.rs: font programs built here (CFF and Type 1, every table the
// readers branch on) and what pdf.js 6.4.299 reads from them, written as text the Rust test renders identically.
//
//   node record.mjs <pdfjs-dist legacy/build/pdf.worker.mjs> <the Foxit standard_fonts directory>
//
// The worker file is only read: a copy with its CFF and Type 1 classes exported is written to the temp directory and
// imported from there. Output: fonts/<name>.bin, expected/<name>.txt and cases.rs, beside this script. Nothing in
// the fonts is third-party content; the two Foxit programs are the ones the crate embeds.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [, , workerPath, foxitDir] = process.argv;
if (!workerPath || !foxitDir) {
  console.error("usage: node record.mjs <pdf.worker.mjs> <standard_fonts dir>");
  process.exit(2);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfjs-cff-type1-"));
const patchedPath = path.join(tempDir, "pdf.worker.patched.mjs");
fs.writeFileSync(
  patchedPath,
  fs
    .readFileSync(workerPath, "utf8")
    .replace("export { WorkerMessageHandler };", "export { CFFFont, Stream, Type1Font };"),
);
const pdfjs = await import(pathToFileURL(patchedPath).href);
fs.rmSync(tempDir, { recursive: true, force: true });
const { CFFFont, Stream, Type1Font } = pdfjs;
// pdf.js writes its warnings to the console.
console.log = () => {};
const warn = console.warn;
console.warn = () => {};

const fontsDir = path.join(here, "fonts");
const expectedDir = path.join(here, "expected");
fs.mkdirSync(fontsDir, { recursive: true });
fs.mkdirSync(expectedDir, { recursive: true });

// ---- byte helpers -------------------------------------------------------------------------------------------------

const flat = (items) => items.flat(Infinity);
const bytes = (...items) => Uint8Array.from(flat(items));
const concat = (...parts) => bytes(parts.map((p) => Array.from(p)));
const latin1 = (s) => Array.from(s, (c) => c.charCodeAt(0));
const u16 = (v) => [(v >> 8) & 255, v & 255];
const int5 = (v) => [29, (v >> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255];

/** A number operand of a DICT or a Type 2 charstring (integers and, in a DICT, reals). */
function operand(v) {
  if (Number.isInteger(v)) {
    if (v >= -107 && v <= 107) return [v + 139];
    if (v >= 108 && v <= 1131) return [247 + ((v - 108) >> 8), (v - 108) & 255];
    if (v >= -1131 && v <= -108) return [251 + ((-v - 108) >> 8), (-v - 108) & 255];
    if (v >= -32768 && v <= 32767) return [28, ...u16(v & 0xffff)];
    return int5(v);
  }
  const nib = { ".": 0xa, E: 0xb, "-": 0xe };
  const digits = String(v)
    .split("")
    .map((c) => (c in nib ? nib[c] : Number(c)));
  digits.push(0xf);
  if (digits.length % 2) digits.push(0xf);
  const out = [30];
  for (let i = 0; i < digits.length; i += 2) out.push((digits[i] << 4) | digits[i + 1]);
  return out;
}

const OPS = {
  hstem: [1], vstem: [3], vmoveto: [4], rlineto: [5], hlineto: [6], vlineto: [7], rrcurveto: [8],
  callsubr: [10], return: [11], endchar: [14], hstemhm: [18], hintmask: [19], cntrmask: [20], rmoveto: [21],
  hmoveto: [22], vstemhm: [23], callgsubr: [29], and: [12, 3], add: [12, 10], sub: [12, 11], div: [12, 12],
  neg: [12, 14], mul: [12, 24], dotsection: [12, 0],
};

/** A Type 2 charstring: numbers, operator names and { raw: [...] }. */
function cs(...items) {
  const out = [];
  for (const item of items) {
    if (typeof item === "number") out.push(...operand(item));
    else if (typeof item === "string") out.push(...OPS[item]);
    else out.push(...item.raw);
  }
  return bytes(out);
}

function index(objects, offSize = 2) {
  if (objects.length === 0) return bytes(0, 0);
  const out = [...u16(objects.length), offSize];
  let offset = 1;
  const offsets = [offset];
  for (const o of objects) {
    offset += o.length;
    offsets.push(offset);
  }
  for (const off of offsets) for (let i = offSize - 1; i >= 0; i--) out.push((off >> (8 * i)) & 255);
  for (const o of objects) out.push(...o);
  return bytes(out);
}

/** A DICT from [operator, operand bytes] pairs; the operator is a number or [12, x]. */
function dict(entries) {
  const out = [];
  for (const [op, operands] of entries) {
    out.push(...flat(operands));
    out.push(...(Array.isArray(op) ? op : [op]));
  }
  return bytes(out);
}

/** Lays out blocks whose DICTs hold offsets (written with a fixed size): builds twice, the second time with offsets. */
function assemble(build) {
  const zero = new Proxy({}, { get: () => 0 });
  const sizes = build(zero);
  const offsets = {};
  let at = 0;
  for (const [name, data] of sizes) {
    offsets[name] = at;
    at += data.length;
  }
  const blocks = build(offsets);
  return concat(...blocks.map(([, data]) => data));
}

// ---- CFF fonts ----------------------------------------------------------------------------------------------------

const SID = { space: 1, exclam: 2, A: 34, B: 35, C: 36, D: 37 };

/** A non-CID CFF font. */
function cffFont({
  name = "TestFont", strings = [], gsubrs = [], glyphs, charset = 0, encoding = 0, dictExtra = [],
  defaultWidthX = 500, nominalWidthX = 600, subrs = null, privateExtra = [], prefix = [],
}) {
  const font = assemble((off) => {
    const privateDict = (subrsOffset) =>
      dict([
        [20, [operand(defaultWidthX)]], [21, [operand(nominalWidthX)]],
        ...privateExtra,
        ...(subrs ? [[19, [int5(subrsOffset)]]] : []),
      ]);
    const privateSize = privateDict(0).length;
    const top = (off2) =>
      dict([
        ...dictExtra,
        [15, [int5(typeof charset === "number" ? charset : off2.charset)]],
        [16, [int5(typeof encoding === "number" ? encoding : off2.encoding)]],
        [17, [int5(off2.charstrings)]],
        [18, [int5(privateSize), int5(off2.private)]],
      ]);
    return [
      ["header", bytes(1, 0, 4, 2)],
      ["name", index([bytes(latin1(name))])],
      ["top", index([top(off)])],
      ["string", index(strings.map((s) => bytes(latin1(s))))],
      ["gsubr", index(gsubrs)],
      ["charset", typeof charset === "number" ? bytes() : charset.bytes],
      ["encoding", typeof encoding === "number" ? bytes() : encoding.bytes],
      ["charstrings", index(glyphs)],
      ["private", privateDict(privateSize)],
      ["subrs", subrs ? index(subrs) : bytes()],
    ];
  });
  return concat(prefix, font);
}

/** A CID-keyed CFF font with the given Font DICTs ({ defaultWidthX, nominalWidthX, subrs }). */
function cidFont({ glyphs, charsetBytes, fdSelectBytes, fds, gsubrs = [] }) {
  return assemble((off) => {
    const privateDict = (fd, subrsOffset) =>
      dict([
        [20, [operand(fd.defaultWidthX)]], [21, [operand(fd.nominalWidthX)]],
        ...(fd.subrs ? [[19, [int5(subrsOffset)]]] : []),
      ]);
    const privSizes = fds.map((fd) => privateDict(fd, 0).length);
    const fontDicts = fds.map((fd, i) => dict([[18, [int5(privSizes[i]), int5(off[`private${i}`])]]]));
    const top = dict([
      [[12, 30], [int5(391), int5(392), operand(0)]],
      [[12, 34], [operand(10)]],
      [15, [int5(off.charset)]], [17, [int5(off.charstrings)]],
      [[12, 36], [int5(off.fdarray)]], [[12, 37], [int5(off.fdselect)]],
    ]);
    const blocks = [
      ["header", bytes(1, 0, 4, 2)],
      ["name", index([bytes(latin1("TestCID"))])],
      ["top", index([top])],
      ["string", index([bytes(latin1("Adobe")), bytes(latin1("Identity"))])],
      ["gsubr", index(gsubrs)],
      ["charset", charsetBytes],
      ["fdselect", fdSelectBytes],
      ["charstrings", index(glyphs)],
      ["fdarray", index(fontDicts)],
    ];
    fds.forEach((fd, i) => {
      blocks.push([`private${i}`, privateDict(fd, privSizes[i])]);
      blocks.push([`subrs${i}`, fd.subrs ? index(fd.subrs) : bytes()]);
    });
    return blocks;
  });
}

const basicGlyphs = [
  cs("endchar"),
  cs(-50, "endchar"),
  cs(30, 100, 200, "rmoveto", "endchar"),
  cs(100, 200, "rmoveto", 50, "hlineto", "endchar"),
  cs(25, 10, 20, "hstemhm", 30, "hintmask", { raw: [0xc0] }, 100, "hmoveto", "endchar"),
  cs(15, -107, "callsubr", "endchar"),
  cs(-107, "callgsubr", "endchar"),
  cs(40, "dotsection", 10, "hmoveto", "endchar"),
  cs(0, 100, 200, 65, 66, "endchar"),
  cs(5, "rrcurveto", "endchar"),
  cs(50, 100, 200, "add", 7, "rmoveto", "endchar"),
  cs(1000, 2000, 3000, "rmoveto", "endchar"),
  cs({ raw: [255, 0, 2, 0x80, 0] }, 5, 6, "rmoveto", "endchar"),
  cs(),
  cs(10, "hmoveto", { raw: [0] }),
  cs(10, 20, "vstem", 5, 6, "hstem", "endchar"),
];

/** pdf.js's `font.cff` and `properties`, as the text the Rust test renders. */
function num(n) {
  if (n === undefined) return "undefined";
  if (Number.isNaN(n)) return "NaN";
  return Object.is(n, -0) ? "0" : String(n);
}
const list = (a) => a.map(num).join(",");

function dumpCff(font, properties) {
  const cff = font.cff;
  const out = [];
  out.push(`isCID=${cff.isCIDFont}`);
  out.push(`names=${cff.names.join(",")}`);
  out.push(`numGlyphs=${font.numGlyphs}`);
  out.push(`charStringCount=${cff.charStringCount}`);
  out.push(`charset=${cff.charset.charset.map((c) => (typeof c === "number" ? String(c) : String(c))).join(",")}`);
  out.push(`charsetFormat=${cff.charset.predefined ? "predefined" : "custom"}${cff.charset.format}`);
  if (cff.encoding) {
    const codes = Object.keys(cff.encoding.encoding).map(Number).sort((a, b) => a - b);
    out.push(`encoding=${codes.map((c) => `${c}:${cff.encoding.encoding[c]}`).join(",")}`);
    out.push(`encodingFormat=${cff.encoding.predefined ? "predefined" : "custom"}${cff.encoding.format}`);
  } else out.push("encoding=none");
  const be = properties.builtInEncoding;
  out.push(
    be ? `builtIn=${Object.keys(be).map(Number).sort((a, b) => a - b).map((c) => `${c}:${be[c]}`).join(",")}` : "builtIn=none",
  );
  out.push(`widths=${list(cff.widths)}`);
  out.push(`seacs=${[...cff.seacs].map(([g, s]) => `${g}:${list(s)}`).join(";")}`);
  const priv = (d) => `${num(d.privateDict.getByName("defaultWidthX"))}/${num(d.privateDict.getByName("nominalWidthX"))}`;
  out.push(`topPrivate=${priv(cff.topDict)}`);
  out.push(`fdArray=${cff.fdArray.map(priv).join(";")}`);
  out.push(`fdSelect=${cff.fdSelect ? cff.fdSelect.fdSelect.join(",") : "none"}`);
  out.push(`fontMatrix=${properties.fontMatrix ? list(properties.fontMatrix) : "none"}`);
  out.push(`fontBBox=${list(cff.topDict.getByName("FontBBox"))}`);
  out.push(`ascent=${num(properties.ascent)}`);
  out.push(`descent=${num(properties.descent)}`);
  out.push(`hasGlyph=${Array.from({ length: font.numGlyphs + 1 }, (_, i) => (font.hasGlyphId(i) ? 1 : 0)).join("")}`);
  return out;
}

const cases = { cff: [], type1: [] };

function recordCff(name, data, { bbox } = {}, note = "") {
  fs.writeFileSync(path.join(fontsDir, `${name}.bin`), data);
  const input = [`#bbox=${bbox ? list(bbox) : "none"}`];
  const properties = { bbox: bbox ? [...bbox] : undefined, loadedName: name };
  let body;
  try {
    const font = new CFFFont(new Stream(new Uint8Array(data)), properties);
    body = dumpCff(font, properties);
  } catch (e) {
    body = [`error=${e.name === "FormatError" ? `FormatError: ${e.message}` : e.name}`];
  }
  fs.writeFileSync(path.join(expectedDir, `${name}.txt`), [...input, ...body].join("\n") + "\n");
  cases.cff.push(name);
  void note;
}

// ---- Type 1 fonts -------------------------------------------------------------------------------------------------

const T1OPS = {
  hstem: [1], vstem: [3], vmoveto: [4], rlineto: [5], hlineto: [6], vlineto: [7], rrcurveto: [8], closepath: [9],
  callsubr: [10], return: [11], hsbw: [13], endchar: [14], rmoveto: [21], hmoveto: [22], vhcurveto: [30],
  hvcurveto: [31], dotsection: [12, 0], vstem3: [12, 1], hstem3: [12, 2], seac: [12, 6], sbw: [12, 7], div: [12, 12],
  callothersubr: [12, 16], pop: [12, 17], setcurrentpoint: [12, 33],
};

function t1cs(...items) {
  const out = [];
  for (const item of items) {
    if (typeof item === "string") out.push(...T1OPS[item]);
    else if (item >= -107 && item <= 107) out.push(item + 139);
    else if (item >= 108 && item <= 1131) out.push(247 + ((item - 108) >> 8), (item - 108) & 255);
    else if (item >= -1131 && item <= -108) out.push(251 + ((-item - 108) >> 8), (-item - 108) & 255);
    else out.push(255, (item >> 24) & 255, (item >> 16) & 255, (item >> 8) & 255, item & 255);
  }
  return out;
}

function encrypt(plain, key, prefix) {
  let r = key;
  const out = [];
  for (const p of [...prefix, ...plain]) {
    const c = p ^ (r >> 8);
    r = ((c + r) * 52845 + 22719) & 0xffff;
    out.push(c);
  }
  return out;
}

const LEN_IV_PREFIX = [0x41, 0x42, 0x43, 0x44];
/** A charstring as the file stores it for `lenIV`. */
function t1stored(codes, lenIV) {
  return lenIV === -1 ? codes : encrypt(codes, 4330, LEN_IV_PREFIX.slice(0, lenIV));
}

const t1Glyphs = [
  [".notdef", t1cs(0, 250, "hsbw", "endchar")],
  ["A", t1cs(50, 600, "hsbw", 0, 0, "rmoveto", 100, "hlineto", "closepath", "endchar")],
  ["B", t1cs(50, 650, "hsbw", 4, "callsubr", "endchar")],
  ["C", t1cs(3, "callsubr", "endchar")],
  ["a", t1cs(10, 20, 800, 0, "sbw", 5, "hlineto", "endchar")],
  ["b", t1cs(0, 1500, 2, "div", "hsbw", "endchar")],
  ["flexg", t1cs(10, 900, "hsbw", 0, 1, "callothersubr", 1, 2, "rmoveto", 3, 4, "rmoveto", 5, 6, "rmoveto", 7, 8, "rmoveto",
    9, 10, "rmoveto", 11, 12, "rmoveto", 13, 14, "rmoveto", 50, 100, 200, 3, 0, "callothersubr", "pop", "pop",
    "setcurrentpoint", "endchar")],
  ["aacute", t1cs(0, 700, "hsbw", 5, 10, 20, 65, 66, "seac")],
  ["bad", t1cs(0, 333, "hsbw", 1, 2, "rrcurveto", "endchar")],
  ["empty", []],
  ["big", t1cs(-20, 2000, "hsbw", "endchar")],
];
const t1Subrs = [t1cs("return"), t1cs("return"), t1cs("return"), t1cs(70, 700, "hsbw", "return"), t1cs(100, "hlineto", "return")];

function headerText({ encoding = "custom" } = {}) {
  const enc =
    encoding === "standard"
      ? "/Encoding StandardEncoding def\n"
      : "/Encoding 256 array\n0 1 255 {1 index exch /.notdef put} for\ndup 65 /A put\ndup 66 /B put\ndup 97 /a put\ndup 50 /C put\nreadonly def\n";
  return (
    "%!PS-AdobeFont-1.0: TestFont 001.000\n%%CreationDate: today\n11 dict begin\n/FontName /TestFont def\n" +
    "/FontMatrix [0.001 0 0 0.001 0 0] readonly def\n/FontBBox {-100 -200 1000 900} readonly def\n" +
    enc +
    "currentdict end\ncurrentfile eexec\n"
  );
}

function privateText({ lenIV = 4, rd = "RD", nd = "ND", np = "NP", glyphs = t1Glyphs, subrs = t1Subrs } = {}) {
  const parts = [];
  const text = (s) => parts.push(...latin1(s));
  text("dup /Private 12 dict dup begin\n");
  text(`/${rd} {string currentfile exch readstring pop} executeonly def\n`);
  text(`/${nd} {noaccess def} executeonly def\n/${np} {noaccess put} executeonly def\n`);
  text("/BlueValues [-15 0 700 715] def\n/StdHW [50] def\n/ForceBold false def\n/BlueScale 0.039 def\n");
  if (lenIV !== 4) text(`/lenIV ${lenIV} def\n`);
  text(`/Subrs ${subrs.length} array\n`);
  subrs.forEach((codes, i) => {
    const stored = t1stored(codes, lenIV);
    text(`dup ${i} ${stored.length} ${rd} `);
    parts.push(...stored);
    text(` ${np}\n`);
  });
  text(`${nd}\n2 index /CharStrings ${glyphs.length} dict dup begin\n`);
  for (const [name, codes] of glyphs) {
    const stored = t1stored(codes, lenIV);
    text(`/${name} ${stored.length} ${rd} `);
    parts.push(...stored);
    text(` ${nd}\n`);
  }
  text("end\nend\nreadonly put\nnoaccess put\ndup /FontName get exch definefont pop\nmark currentfile closefile\n");
  return parts;
}

const TRAILER = latin1(("0".repeat(64) + "\n").repeat(8) + "cleartomark\n");

function type1Raw(options = {}, { hex = false } = {}) {
  const head = latin1(headerText(options));
  const secret = encrypt(privateText(options), 55665, [0x11, 0x22, 0x33, 0x44]);
  let body;
  if (hex) {
    const digits = secret.map((b) => b.toString(16).padStart(2, "0")).join("");
    body = latin1(digits.replace(/(.{64})/g, "$1\n") + "\n");
  } else body = secret;
  return { data: bytes(head, body, TRAILER), length1: head.length, headerLength: head.length, secret };
}

function type1Pfb(options = {}) {
  const head = latin1(headerText(options));
  const secret = encrypt(privateText(options), 55665, [0x11, 0x22, 0x33, 0x44]);
  const seg = (type, data) => [0x80, type, data.length & 255, (data.length >> 8) & 255, (data.length >> 16) & 255, (data.length >> 24) & 255, ...data];
  return bytes(seg(1, head), seg(2, secret), seg(1, TRAILER), [0x80, 3]);
}

function dumpType1(font, properties) {
  const out = [];
  out.push(`numGlyphs=${font.numGlyphs}`);
  out.push(`charset=${font.getCharset().join(",")}`);
  out.push(
    `glyphs=${font.charstrings.map((c) => `${c.glyphName}:${num(c.width)}:${num(c.lsb)}:${c.charstring.length > 0 ? 1 : 0}`).join(";")}`,
  );
  out.push(`seacs=${[...font.seacs].map(([g, s]) => `${g}:${list(s)}`).join(";")}`);
  const be = properties.builtInEncoding;
  out.push(
    be ? `builtIn=${Object.keys(be).map(Number).sort((a, b) => a - b).map((c) => `${c}:${be[c]}`).join(",")}` : "builtIn=none",
  );
  out.push(`widths=${Object.keys(properties.widths).map(Number).sort((a, b) => a - b).map((c) => `${c}:${num(properties.widths[c])}`).join(",")}`);
  out.push(`fontMatrix=${properties.fontMatrix ? list(properties.fontMatrix) : "none"}`);
  out.push(`ascent=${num(properties.ascent)}`);
  out.push(`descent=${num(properties.descent)}`);
  out.push(`hasGlyph=${Array.from({ length: font.numGlyphs + 1 }, (_, i) => (font.hasGlyphId(i) ? 1 : 0)).join("")}`);
  return out;
}

function recordType1(name, data, { length1, composite = false, firstChar = 0, lastChar = 255, widths = {} } = {}) {
  fs.writeFileSync(path.join(fontsDir, `${name}.bin`), data);
  const preset = Object.entries(widths).map(([c, w]) => `${c}:${w}`).join(",");
  const input = [
    `#length1=${length1 === undefined ? "none" : length1}`,
    `#composite=${composite}`,
    `#firstChar=${firstChar}`,
    `#lastChar=${lastChar}`,
    `#widths=${preset}`,
  ];
  const properties = {
    length1, composite, firstChar, lastChar, widths: [], bbox: [0, 0, 0, 0], fontMatrix: [0.001, 0, 0, 0.001, 0, 0],
    cMap: { charCodeOf: (g) => g }, loadedName: name,
  };
  for (const [c, w] of Object.entries(widths)) properties.widths[Number(c)] = w;
  let body;
  try {
    const font = new Type1Font(name, new Stream(new Uint8Array(data)), properties);
    body = dumpType1(font, properties);
  } catch (e) {
    body = [`error=${e.name === "FormatError" ? `FormatError: ${e.message}` : e.name}`];
  }
  fs.writeFileSync(path.join(expectedDir, `${name}.txt`), [...input, ...body].join("\n") + "\n");
  cases.type1.push(name);
}

// ---- the CFF cases ------------------------------------------------------------------------------------------------

const localSubrs = [cs(10, 20, "rmoveto", "return"), cs(5, "hmoveto", "return"), cs("return")];
const globalSubrs = [cs(30, "hmoveto", "return")];
const basic = {
  glyphs: basicGlyphs, subrs: localSubrs, gsubrs: globalSubrs,
  dictExtra: [[[12, 7], ["0.0005", "0", "0", "0.0005", "0", "0"].map((s) => operand(Number(s)))], [5, [-50, -200, 1000, 900].map(operand)]],
};
const basicFont = cffFont(basic);
recordCff("cff-basic-predefined", basicFont);
recordCff("cff-shifted-header", concat([0, 0, 0], basicFont));
recordCff("cff-descriptor-bbox", cffFont({ ...basic, dictExtra: [[5, [int5(0), int5(0), int5(0), int5(0)]]] }), { bbox: [-50, -200, 1000, 900] });
recordCff(
  "cff-unsigned-bbox",
  cffFont({ ...basic, dictExtra: [[5, [int5(65486), int5(65336), int5(1000), int5(900)]]] }),
  { bbox: [-50, -200, 1000, 900] },
);
recordCff(
  "cff-unsigned-lower-left",
  cffFont({ ...basic, dictExtra: [[5, [int5(65486), int5(65336), int5(1000), int5(900)]]] }),
);

recordCff(
  "cff-charset0-encoding0-supplement",
  cffFont({
    strings: ["alpha", "beta", "gamma"],
    glyphs: [cs("endchar"), cs(10, 20, "rmoveto", "endchar"), cs("endchar"), cs(-30, "endchar"), cs(7, "hmoveto", "endchar"), cs("endchar")],
    charset: { bytes: bytes(0, u16(391), u16(392), u16(393), u16(SID.A), u16(SID.B)) },
    encoding: { bytes: bytes(0x80, 3, 65, 66, 67, 2, 100, u16(392), 101, u16(SID.B)) },
    defaultWidthX: 250, nominalWidthX: 300,
  }),
);
recordCff(
  "cff-charset1-encoding1",
  cffFont({
    strings: ["x1", "y1"],
    glyphs: Array.from({ length: 7 }, (_, i) => cs(i * 10, 5, "hmoveto", "endchar")),
    charset: { bytes: bytes(1, u16(SID.A), 3, u16(391), 1) },
    encoding: { bytes: bytes(1, 2, 65, 3, 97, 1) },
  }),
);
recordCff(
  "cff-charset2-expert-encoding",
  cffFont({
    glyphs: Array.from({ length: 6 }, (_, i) => cs(i, 7, "hmoveto", "endchar")),
    charset: { bytes: bytes(2, u16(229), u16(4)) },
    encoding: 1,
  }),
);
recordCff(
  "cff-expert-charset",
  cffFont({ glyphs: Array.from({ length: 12 }, (_, i) => cs(i * 3, 7, "hmoveto", "endchar")), charset: 1, encoding: 1 }),
);

const cidGlyphs = [
  cs("endchar"), cs(5, 10, 20, "rmoveto", "endchar"), cs(20, "hmoveto", "endchar"),
  cs(-107, "callsubr", 8, "hmoveto", "endchar"), cs(9, 40, 50, "rmoveto", "endchar"), cs("endchar"),
];
const cidCharset = bytes(2, u16(1), u16(2), u16(10), u16(1));
recordCff(
  "cff-cid-fdselect3",
  cidFont({
    glyphs: cidGlyphs, charsetBytes: cidCharset,
    fdSelectBytes: bytes(3, u16(2), u16(0), 0, u16(3), 1, u16(6)),
    fds: [{ defaultWidthX: 1000, nominalWidthX: 0 }, { defaultWidthX: 500, nominalWidthX: 100, subrs: [cs(12, "hmoveto", "return")] }],
    gsubrs: globalSubrs,
  }),
);
recordCff(
  "cff-cid-fdselect0",
  cidFont({
    glyphs: cidGlyphs, charsetBytes: cidCharset,
    fdSelectBytes: bytes(0, 0, 0, 0, 1, 1, 0),
    fds: [{ defaultWidthX: 900, nominalWidthX: 10 }, { defaultWidthX: 800, nominalWidthX: 20 }],
  }),
);
recordCff(
  "cff-cid-fdselect-short",
  cidFont({
    glyphs: cidGlyphs, charsetBytes: cidCharset,
    fdSelectBytes: bytes(3, u16(1), u16(0), 0, u16(4)),
    fds: [{ defaultWidthX: 900, nominalWidthX: 10 }],
  }),
);
recordCff("cff-no-header", bytes(0, 0, 0, 0, 0, 0, 0, 0));
recordCff("cff-truncated", basicFont.slice(0, 60));

// The two Foxit standard fonts, read by CFFFont as pdf.js reads them.
for (const [name, file] of [["foxit-symbol", "FoxitSymbol.pfb"], ["foxit-dingbats", "FoxitDingbats.pfb"]]) {
  recordCff(name, new Uint8Array(fs.readFileSync(path.join(foxitDir, file))));
}

// ---- the Type 1 cases ---------------------------------------------------------------------------------------------

const raw = type1Raw();
recordType1("t1-raw-binary", raw.data, { length1: raw.length1 });
recordType1("t1-raw-binary-widths", raw.data, { length1: raw.length1, firstChar: 60, lastChar: 100, widths: { 65: 999 } });
recordType1("t1-raw-binary-composite", raw.data, { length1: raw.length1, composite: true });
recordType1("t1-raw-wrong-length1", raw.data, { length1: raw.length1 - 12 });
recordType1("t1-raw-no-length1", raw.data, {});
recordType1("t1-pfb", type1Pfb(), {});
recordType1("t1-pfb-length1", type1Pfb(), { length1: 5 });
recordType1("t1-hex", type1Raw({}, { hex: true }).data, { length1: raw.length1 });
{
  const r = type1Raw({ encoding: "standard" });
  recordType1("t1-standard-encoding", r.data, { length1: r.length1, firstChar: 0, lastChar: 255 });
}
{
  const r = type1Raw({ lenIV: -1, rd: "-|", nd: "|-", np: "|" });
  recordType1("t1-leniv-minus1", r.data, { length1: r.length1 });
}
{
  const r = type1Raw({ lenIV: 0 });
  recordType1("t1-leniv-0", r.data, { length1: r.length1 });
}
{
  const head = latin1(headerText());
  recordType1("t1-no-eexec", bytes(head), { length1: head.length });
}

// CID-keyed Type 1: a CIDMap with FDBytes 1, GDBytes 2 and a subroutine map.
function cidType1({ hex = false, lenIV = 4 } = {}) {
  const store = (codes) => t1stored(codes, lenIV);
  const subr = store(t1cs(30, "hmoveto", "return"));
  const glyphCodes = [
    t1cs(0, 500, "hsbw", "endchar"),
    t1cs(10, 600, "hsbw", 0, "callsubr", "endchar"),
    null,
    t1cs(20, 700, "hsbw", "endchar"),
  ];
  const cidCount = glyphCodes.length;
  const mapSize = (cidCount + 1) * 3;
  const subrMapOffset = mapSize;
  const subrDataStart = subrMapOffset + 2 * 2;
  const stored = glyphCodes.map((g) => (g ? store(g) : []));
  let at = subrDataStart + subr.length;
  const offsets = [at];
  for (const s of stored) {
    at += s.length;
    offsets.push(at);
  }
  const binary = [];
  offsets.slice(0, cidCount + 1).forEach((o) => binary.push(0, ...u16(o)));
  binary.push(...u16(subrDataStart), ...u16(subrDataStart + subr.length));
  binary.push(...subr);
  for (const s of stored) binary.push(...s);
  const dataText = hex ? binary.map((b) => b.toString(16).padStart(2, "0")).join("") : null;
  const header =
    "%!PS-Adobe-3.0 Resource-CIDFont\n%%DocumentNeededResources: ProcSet (CIDInit)\n/CIDFontName /TestCID def\n" +
    `/CIDFontType 0 def\n/CIDCount ${cidCount} def\n/FontMatrix [0.001 0 0 0.001 0 0] def\n/FontBBox {0 -250 1000 800} def\n` +
    `/FDBytes 1 def\n/GDBytes 2 def\n/CIDMapOffset 0 def\n/SubrMapOffset ${subrMapOffset} def\n/SDBytes 2 def\n/SubrCount 1 def\n` +
    (lenIV !== 4 ? `/lenIV ${lenIV} def\n` : "") +
    `(${hex ? "Hex" : "Binary"}) ${binary.length} StartData `;
  return bytes(latin1(header), hex ? latin1(dataText) : binary);
}
recordType1("t1-cid-binary", cidType1(), { composite: true });
recordType1("t1-cid-hex", cidType1({ hex: true }), { composite: true });
recordType1("t1-cid-leniv-0", cidType1({ lenIV: 0 }), { composite: true });
recordType1("t1-cid-not-composite", cidType1(), {});

// ---- the manifest -------------------------------------------------------------------------------------------------

const rows = [
  "// Generated by record.mjs; do not edit.",
  "//! The twin cases: font programs and what pdf.js 6.4.299 reads from them.",
  "",
  "/// `(name, font program, expected text)` of the CFF cases.",
  "pub static CFF_CASES: &[(&str, &[u8], &str)] = &[",
  ...cases.cff.map((n) => `    ("${n}", include_bytes!("fonts/${n}.bin"), include_str!("expected/${n}.txt")),`),
  "];",
  "",
  "/// `(name, font program, expected text)` of the Type 1 cases.",
  "pub static TYPE1_CASES: &[(&str, &[u8], &str)] = &[",
  ...cases.type1.map((n) => `    ("${n}", include_bytes!("fonts/${n}.bin"), include_str!("expected/${n}.txt")),`),
  "];",
  "",
];
fs.writeFileSync(path.join(here, "cases.rs"), rows.join("\n"));
// Laid out as the workspace formats Rust (native/rustfmt.toml, found from the file's folder), so a regeneration leaves no diff.
execFileSync("rustfmt", [path.join(here, "cases.rs")]);
console.warn = warn;
console.error(`recorded ${cases.cff.length} CFF and ${cases.type1.length} Type 1 cases`);
