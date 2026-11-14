#!/usr/bin/env node
// The corpus of the JPEG 2000 container and codestream reader of `mixdog-pdf` (WP nr-office-pdf-jpx-codestream).
//
//   node benchmarks/rust-core/recorders/record-office-jpx.mjs [--pdfjs <pdfjs-dist dir>]     (default: node_modules/pdfjs-dist)
//
// Writes native/core/fixtures/office-jpx/: one codestream or JP2 file per case, `expected.json` and `MANIFEST.json`.
//
// There is no JPEG 2000 encoder in the tree, so the cases are built here: a small writer lays down the marker segments
// and the packets (packet headers with tag trees, bit stuffing, SOP/EPH, PPM/PPT, tile-parts, TLM/PLT, POC) from a case
// description, with the geometry computed from the formulas of ITU-T T.800 annex B and the packet order from the
// literal position loops of B.12.1. Code-block bytes are seeded noise: tier-2 reads their lengths, not their meaning.
// `expected.json` records, per case, what the writer put in (packet order, empty flags, data lengths, geometry,
// per-block passes and segments) and what OpenJPEG does with the file: pdf.js 6.4.299's own `JpxImage` (OpenJPEG as
// compiled into wasm/openjpeg.wasm) decodes it through `image_decoders`, and its dimensions and component count are
// recorded. OpenJPEG's header dump itself is not reachable through pdf.js, only those results.
//
// Which module the Node configurations load: the application sets no `wasmUrl`, so pdf.js's `JpxImage` imports
// `nullopenjpeg_nowasm_fallback.js`, fails, and every decode throws "OpenJPEG failed to initialize" (recorded as
// `nodeDefault`). The reference values below load openjpeg.wasm explicitly.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const args = process.argv.slice(2);
const pdfjsDir = resolve(args[args.indexOf('--pdfjs') + 1] || join(ROOT, 'node_modules', 'pdfjs-dist'));
const OUT = join(ROOT, 'native', 'core', 'fixtures', 'office-jpx');

// ---- bytes -------------------------------------------------------------------------------------------------------

const u16 = (n) => [(n >> 8) & 255, n & 255];
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const cat = (...parts) => Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
const segment = (marker, body) => cat(u16(marker), u16(body.length + 2), body);
const M = { SOC: 0xff4f, SIZ: 0xff51, COD: 0xff52, COC: 0xff53, TLM: 0xff55, PLT: 0xff58, QCD: 0xff5c, QCC: 0xff5d, RGN: 0xff5e, POC: 0xff5f, PPM: 0xff60, PPT: 0xff61, COM: 0xff64, SOT: 0xff90, SOP: 0xff91, EPH: 0xff92, SOD: 0xff93, EOC: 0xffd9 };

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ceilDiv = (a, b) => Math.floor((a + b - 1) / b);
const floorDiv = (a, b) => Math.floor(a / b);
const p2 = (n) => 2 ** n;
const bitLength = (n) => (n === 0 ? 0 : Math.floor(Math.log2(n)) + 1);
const floorLog2 = (n) => Math.floor(Math.log2(n));

/** Packet-header bit writer: the byte after a 0xFF carries seven bits. */
class BitWriter {
  constructor() { this.bytes = []; this.cur = 0; this.left = 8; }
  bit(b) {
    this.left -= 1;
    this.cur |= (b ? 1 : 0) << this.left;
    if (this.left === 0) this.flushByte();
  }
  flushByte() {
    this.bytes.push(this.cur);
    this.left = this.cur === 0xff ? 7 : 8;
    this.cur = 0;
  }
  bits(v, n) { for (let i = n - 1; i >= 0; i--) this.bit((v >> i) & 1); }
  finish() {
    const last = () => this.bytes[this.bytes.length - 1];
    const full = this.bytes.length && last() === 0xff ? 7 : 8;
    if (this.left !== full) this.flushByte();
    if (this.bytes.length && last() === 0xff) this.bytes.push(0);
    return Buffer.from(this.bytes);
  }
}

/** Tag tree encoder (annex B.10.2). */
class TagTreeEnc {
  constructor(w, h) {
    this.levels = [];
    let lw = w, lh = h;
    for (;;) {
      this.levels.push({ w: lw, h: lh, nodes: Array.from({ length: lw * lh }, () => ({ value: 999, low: 0, known: false })) });
      if (lw === 1 && lh === 1) break;
      lw = ceilDiv(lw, 2); lh = ceilDiv(lh, 2);
    }
  }
  set(x, y, v) {
    for (let l = 0; l < this.levels.length; l++) {
      const lv = this.levels[l];
      const n = lv.nodes[(y >> l) * lv.w + (x >> l)];
      if (v < n.value) n.value = v;
    }
  }
  value(x, y) { return this.levels[0].nodes[y * this.levels[0].w + x].value; }
  encode(bw, x, y, threshold) {
    let low = 0;
    for (let l = this.levels.length - 1; l >= 0; l--) {
      const lv = this.levels[l];
      const n = lv.nodes[(y >> l) * lv.w + (x >> l)];
      if (low > n.low) n.low = low; else low = n.low;
      while (low < threshold) {
        if (low >= n.value) {
          if (!n.known) { bw.bit(1); n.known = true; }
          break;
        }
        bw.bit(0);
        low++;
      }
      n.low = low;
    }
  }
}

// ---- case description -> parameters ------------------------------------------------------------------------------

const BYPASS = 1, TERMALL = 4;

function quantFor(q, levels) {
  const nb = 3 * levels + 1;
  const steps = [];
  for (let b = 0; b < nb; b++) {
    const r = b === 0 ? 0 : Math.ceil(b / 3);
    if (q.style === 0) steps.push({ expn: 8 + (b % 3), mant: 0 });
    else if (q.style === 1) steps.push({ expn: Math.max(0, 12 - Math.max(0, r - 1)), mant: 0x120 });
    else steps.push({ expn: 10 + (b % 3), mant: 64 * b + 5 });
  }
  return { style: q.style, guard: q.guard, steps };
}

function resolveComp(cfg, c, tile) {
  const base = { levels: cfg.levels, cbw: cfg.cbw, cbh: cfg.cbh, style: cfg.cbstyle || 0, rev: cfg.reversible, precincts: cfg.precincts || null, quant: { style: cfg.quantStyle, guard: 2 } };
  const coc = (cfg.coc || {})[c];
  if (coc) Object.assign(base, coc);
  const qcc = (cfg.qcc || {})[c];
  if (qcc) base.quant = { ...base.quant, ...qcc };
  if (tile) {
    const t = (cfg.tiles || {})[tile] || {};
    if (t.levels !== undefined && !(cfg.coc || {})[c]) base.levels = t.levels;
  }
  if (base.precincts && base.precincts.length !== base.levels + 1) base.precincts = base.precincts.slice(0, base.levels + 1);
  // A QCD covers every component without a QCC, whatever levels a COC gave it: its band list is the main (or tile) one.
  const tileLevels = tile !== null && tile !== undefined ? ((cfg.tiles || {})[tile] || {}).levels : undefined;
  base.quantResolved = quantFor(base.quant, qcc ? base.levels : (tileLevels ?? cfg.levels));
  base.effective = (b) => {
    const q = base.quantResolved;
    if (q.style === 1) {
      const r = b === 0 ? 0 : Math.ceil(b / 3);
      return b === 0 ? q.steps[0] : { expn: Math.max(0, q.steps[0].expn - (r - 1)), mant: q.steps[0].mant };
    }
    return q.steps[b] || { expn: 0, mant: 0 };
  };
  base.roi = ((cfg.rgn || {})[c]) || 0;
  return base;
}

// ---- geometry (annex B) ------------------------------------------------------------------------------------------

function tileGeometry(cfg, t) {
  const nx = ceilDiv(cfg.X1 - cfg.tx0, cfg.tw);
  const p = t % nx, q = Math.floor(t / nx);
  const x0 = Math.max(cfg.tx0 + p * cfg.tw, cfg.X0), y0 = Math.max(cfg.ty0 + q * cfg.th, cfg.Y0);
  const x1 = Math.min(cfg.tx0 + (p + 1) * cfg.tw, cfg.X1), y1 = Math.min(cfg.ty0 + (q + 1) * cfg.th, cfg.Y1);
  const comps = cfg.comps.map((cs, c) => {
    const prm = resolveComp(cfg, c, t);
    const NL = prm.levels;
    const cx0 = ceilDiv(x0, cs.dx), cy0 = ceilDiv(y0, cs.dy), cx1 = ceilDiv(x1, cs.dx), cy1 = ceilDiv(y1, cs.dy);
    const res = [];
    for (let r = 0; r <= NL; r++) {
      const lvl = NL - r;
      const rx0 = ceilDiv(cx0, p2(lvl)), ry0 = ceilDiv(cy0, p2(lvl)), rx1 = ceilDiv(cx1, p2(lvl)), ry1 = ceilDiv(cy1, p2(lvl));
      const [ppx, ppy] = prm.precincts ? prm.precincts[r] : [15, 15];
      const pw = rx1 > rx0 ? ceilDiv(rx1, p2(ppx)) - floorDiv(rx0, p2(ppx)) : 0;
      const ph = ry1 > ry0 ? ceilDiv(ry1, p2(ppy)) - floorDiv(ry0, p2(ppy)) : 0;
      const orients = r === 0 ? [0] : [1, 2, 3];
      const bands = orients.map((orient) => {
        const nb = NL - r + 1;
        const xo = orient & 1, yo = orient >> 1;
        const b = r === 0
          ? { x0: rx0, y0: ry0, x1: rx1, y1: ry1 }
          : { x0: ceilDiv(cx0 - p2(nb - 1) * xo, p2(nb)), y0: ceilDiv(cy0 - p2(nb - 1) * yo, p2(nb)), x1: ceilDiv(cx1 - p2(nb - 1) * xo, p2(nb)), y1: ceilDiv(cy1 - p2(nb - 1) * yo, p2(nb)) };
        const bandIndex = r === 0 ? 0 : 3 * (r - 1) + orient;
        const st = prm.effective(bandIndex);
        const precincts = [];
        for (let py = 0; py < ph; py++) {
          for (let px = 0; px < pw; px++) {
            const X0 = (floorDiv(rx0, p2(ppx)) + px) * p2(ppx), X1 = X0 + p2(ppx);
            const Y0 = (floorDiv(ry0, p2(ppy)) + py) * p2(ppy), Y1 = Y0 + p2(ppy);
            const reg = r === 0 ? [X0, Y0, X1, Y1] : [X0 / 2, Y0 / 2, X1 / 2, Y1 / 2];
            const ix0 = Math.max(reg[0], b.x0), iy0 = Math.max(reg[1], b.y0), ix1 = Math.min(reg[2], b.x1), iy1 = Math.min(reg[3], b.y1);
            const cwe = Math.min(prm.cbw, r === 0 ? ppx : ppx - 1), che = Math.min(prm.cbh, r === 0 ? ppy : ppy - 1);
            let cw = 0, ch = 0, blocks = [];
            if (ix1 > ix0 && iy1 > iy0) {
              cw = ceilDiv(ix1, p2(cwe)) - floorDiv(ix0, p2(cwe));
              ch = ceilDiv(iy1, p2(che)) - floorDiv(iy0, p2(che));
              for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
                const bx0 = (floorDiv(ix0, p2(cwe)) + i) * p2(cwe), by0 = (floorDiv(iy0, p2(che)) + j) * p2(che);
                blocks.push([Math.max(bx0, ix0), Math.max(by0, iy0), Math.min(bx0 + p2(cwe), ix1), Math.min(by0 + p2(che), iy1)]);
              }
            }
            precincts.push({ x0: ix0, y0: iy0, x1: ix1, y1: iy1, cw, ch, blocks });
          }
        }
        return { orient, ...b, expn: st.expn, mant: st.mant, numbps: st.expn + prm.quantResolved.guard - 1, precincts };
      });
      res.push({ x0: rx0, y0: ry0, x1: rx1, y1: ry1, pw, ph, ppx, ppy, bands });
    }
    return { prm, x0: cx0, y0: cy0, x1: cx1, y1: cy1, res };
  });
  return { x0, y0, x1, y1, comps };
}

// ---- packet order (B.12.1, literal position loops) ---------------------------------------------------------------

function orderFor(cfg, geo, prog, bounds) {
  const out = [];
  const { r0, r1, c0, c1, layers } = bounds;
  const comps = geo.comps;
  const nr = (c) => comps[c].res.length;
  const np = (c, r) => comps[c].res[r].pw * comps[c].res[r].ph;
  const atPosition = (c, r, x, y) => {
    const cs = cfg.comps[c], co = comps[c], res = co.res[r], NL = nr(c) - 1, lvl = NL - r;
    if (np(c, r) === 0) return -1;
    const trx0 = ceilDiv(co.x0, p2(lvl)) , try0 = ceilDiv(co.y0, p2(lvl));
    const okY = y % (cs.dy * p2(res.ppy + lvl)) === 0 || (y === geo.y0 && (try0 * p2(lvl)) % p2(res.ppy + lvl) !== 0);
    const okX = x % (cs.dx * p2(res.ppx + lvl)) === 0 || (x === geo.x0 && (trx0 * p2(lvl)) % p2(res.ppx + lvl) !== 0);
    if (!okX || !okY) return -1;
    const rx0 = res.x0, ry0 = res.y0;
    const kx = floorDiv(ceilDiv(x, cs.dx * p2(lvl)), p2(res.ppx)) - floorDiv(rx0, p2(res.ppx));
    const ky = floorDiv(ceilDiv(y, cs.dy * p2(lvl)), p2(res.ppy)) - floorDiv(ry0, p2(res.ppy));
    return kx + res.pw * ky;
  };
  if (prog === 0) {
    for (let l = 0; l < layers; l++) for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) if (r < nr(c)) for (let k = 0; k < np(c, r); k++) out.push([l, r, c, k]);
  } else if (prog === 1) {
    for (let r = r0; r < r1; r++) for (let l = 0; l < layers; l++) for (let c = c0; c < c1; c++) if (r < nr(c)) for (let k = 0; k < np(c, r); k++) out.push([l, r, c, k]);
  } else if (prog === 2) {
    for (let r = r0; r < r1; r++) for (let y = geo.y0; y < geo.y1; y++) for (let x = geo.x0; x < geo.x1; x++) for (let c = c0; c < c1; c++) {
      if (r >= nr(c)) continue;
      const k = atPosition(c, r, x, y);
      if (k >= 0) for (let l = 0; l < layers; l++) out.push([l, r, c, k]);
    }
  } else if (prog === 3) {
    for (let y = geo.y0; y < geo.y1; y++) for (let x = geo.x0; x < geo.x1; x++) for (let c = c0; c < c1; c++) for (let r = r0; r < Math.min(r1, nr(c)); r++) {
      const k = atPosition(c, r, x, y);
      if (k >= 0) for (let l = 0; l < layers; l++) out.push([l, r, c, k]);
    }
  } else {
    for (let c = c0; c < c1; c++) for (let y = geo.y0; y < geo.y1; y++) for (let x = geo.x0; x < geo.x1; x++) for (let r = r0; r < Math.min(r1, nr(c)); r++) {
      const k = atPosition(c, r, x, y);
      if (k >= 0) for (let l = 0; l < layers; l++) out.push([l, r, c, k]);
    }
  }
  return out;
}

function packetOrder(cfg, geo, tile) {
  const t = (cfg.tiles || {})[tile] || {};
  const prog = t.prog ?? cfg.prog, layers = t.layers ?? cfg.layers;
  const maxRes = Math.max(...geo.comps.map((c) => c.res.length));
  const nc = cfg.comps.length;
  const list = cfg.pocs && !t.noPoc
    ? cfg.pocs.map((p) => ({ prog: p.prog, bounds: { r0: p.res0, r1: Math.min(p.res1, maxRes), c0: p.comp0, c1: Math.min(p.comp1, nc), layers: Math.min(p.layer1, layers) } }))
    : [{ prog, bounds: { r0: 0, r1: maxRes, c0: 0, c1: nc, layers } }];
  const seen = new Set();
  const out = [];
  for (const { prog: pr, bounds } of list) {
    for (const pk of orderFor(cfg, geo, pr, bounds)) {
      const key = pk.join(',');
      if (!seen.has(key)) { seen.add(key); out.push(pk); }
    }
  }
  return out;
}

// ---- packets -----------------------------------------------------------------------------------------------------

function newBlockState(rand, layers, idx) {
  return { first: idx % 3 === 2 && layers > 1 ? 1 : 0, zero: Math.floor(rand() * 4), passes: 0, segs: [], lblock: 3, rand };
}

/** The segments a block's next `n` passes fall into (annex B.10.7.2), appending to `st.segs`; returns [segIndex, passes]. */
function planSegments(st, n, style) {
  const out = [];
  const newSeg = () => {
    const prev = st.segs[st.segs.length - 1];
    let max = 109;
    if (style & TERMALL) max = 1;
    else if (style & BYPASS) max = !prev ? 10 : (prev.max === 1 || prev.max === 10 ? 2 : 1);
    st.segs.push({ passes: 0, max, len: 0 });
  };
  if (!st.segs.length) newSeg();
  else if (st.segs[st.segs.length - 1].passes === st.segs[st.segs.length - 1].max) newSeg();
  let left = n;
  for (;;) {
    const s = st.segs[st.segs.length - 1];
    const take = Math.min(s.max - s.passes, left);
    s.passes += take;
    out.push([st.segs.length - 1, take]);
    left -= take;
    if (left === 0) break;
    newSeg();
  }
  return out;
}

function passCode(bw, n) {
  if (n === 1) { bw.bit(0); return; }
  if (n === 2) { bw.bits(2, 2); return; }
  if (n <= 5) { bw.bits(3, 2); bw.bits(n - 3, 2); return; }
  if (n <= 36) { bw.bits(15, 4); bw.bits(n - 6, 5); return; }
  bw.bits(0x1ff, 9); bw.bits(n - 37, 7);
}

/** Writes one packet; returns { header, body, empty, dataLen }. `trees` and `blocks` keep the state between layers. */
function writePacket(cfg, geo, state, tile, [l, r, c, k], index, rand) {
  const res = geo.comps[c].res[r];
  const prm = geo.comps[c].prm;
  const bw = new BitWriter();
  const body = [];
  let dataLen = 0;
  const empty = l > 0 && (index % 3 === 0) && !cfg.noEmpty;
  if (empty) {
    bw.bit(0);
    return { header: bw.finish(), body: Buffer.alloc(0), empty: true, dataLen: 0 };
  }
  bw.bit(1);
  res.bands.forEach((band, bi) => {
    const prc = band.precincts[k];
    if (!prc.cw) return;
    const key = `${tile}/${c}/${r}/${bi}/${k}`;
    let ps = state.get(key);
    if (!ps) {
      ps = { incl: new TagTreeEnc(prc.cw, prc.ch), zero: new TagTreeEnc(prc.cw, prc.ch), blocks: prc.blocks.map((_, i) => newBlockState(rand, cfg.layers, i)) };
      ps.blocks.forEach((b, i) => { ps.incl.set(i % prc.cw, Math.floor(i / prc.cw), Math.min(b.first, (cfg.tiles?.[tile]?.layers ?? cfg.layers) - 1)); ps.zero.set(i % prc.cw, Math.floor(i / prc.cw), b.zero); });
      state.set(key, ps);
    }
    ps.blocks.forEach((b, i) => {
      const x = i % prc.cw, y = Math.floor(i / prc.cw);
      let included;
      const firstTime = b.segs.length === 0;
      if (firstTime) {
        ps.incl.encode(bw, x, y, l + 1);
        included = ps.incl.value(x, y) <= l;
      } else {
        included = (i + l) % 2 === 0 || l === 1;
        bw.bit(included);
      }
      if (!included) return;
      if (firstTime) ps.zero.encode(bw, x, y, 999);
      const n = 1 + ((index + i) % 3) * (l === 0 ? 1 : 2);
      passCode(bw, n);
      const plan = planSegments(b, n, prm.style);
      const lens = plan.map(([si]) => 1 + Math.floor(rand() * 6) + (si % 3) * 4 + (l * 3));
      let inc = 0;
      plan.forEach(([, p], j) => { inc = Math.max(inc, bitLength(lens[j]) - (b.lblock + floorLog2(p))); });
      for (let q = 0; q < inc; q++) bw.bit(1);
      bw.bit(0);
      b.lblock += inc;
      plan.forEach(([si, p], j) => {
        bw.bits(lens[j], b.lblock + floorLog2(p));
        b.segs[si].len += lens[j];
        const bytes = Buffer.alloc(lens[j]);
        for (let z = 0; z < bytes.length; z++) bytes[z] = Math.floor(rand() * 256);
        body.push(bytes);
        dataLen += lens[j];
      });
      b.passes += n;
    });
  });
  return { header: bw.finish(), body: cat(...body), empty: false, dataLen };
}

// ---- codestream ---------------------------------------------------------------------------------------------------

const wide = (cfg) => cfg.comps.length >= 257;
const compIdx = (cfg, c) => (wide(cfg) ? u16(c) : [c]);

function spcod(prm) {
  const prec = prm.precincts ? prm.precincts.map(([x, y]) => (y << 4) | x) : [];
  return [prm.levels, prm.cbw - 2, prm.cbh - 2, prm.style, prm.rev ? 1 : 0, ...prec];
}

function quantBytes(q) {
  const out = [q.style | (q.guard << 5)];
  if (q.style === 0) q.steps.forEach((s) => out.push(s.expn << 3));
  else if (q.style === 1) out.push(...u16((q.steps[0].expn << 11) | q.steps[0].mant));
  else q.steps.forEach((s) => out.push(...u16((s.expn << 11) | s.mant)));
  return out;
}

function varint(n) {
  const bytes = [n & 0x7f];
  n = Math.floor(n / 128);
  while (n > 0) { bytes.unshift((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  return bytes;
}

function buildCodestream(cfg) {
  const rand = prng(cfg.seed || 1);
  const tileCount = ceilDiv(cfg.X1 - cfg.tx0, cfg.tw) * ceilDiv(cfg.Y1 - cfg.ty0, cfg.th);
  const nComps = cfg.comps.length;
  const base = resolveComp(cfg, 0, null);
  const tiles = [];
  for (let t = 0; t < tileCount; t++) {
    const geo = tileGeometry(cfg, t);
    const order = packetOrder(cfg, geo, t);
    const state = new Map();
    const packets = order.map((pk, i) => ({ pk, ...writePacket(cfg, geo, state, t, pk, i, rand) }));
    tiles.push({ t, geo, packets, state });
  }
  // tile-parts: each tile's packets split into `parts` runs
  const parts = cfg.parts || 1;
  const tileParts = [];
  for (let p = 0; p < parts; p++) {
    for (const tl of tiles) {
      const n = tl.packets.length;
      const a = Math.floor((n * p) / parts), b = Math.floor((n * (p + 1)) / parts);
      tileParts.push({ tile: tl.t, part: p, packets: tl.packets.slice(a, b) });
    }
  }
  const sopCount = new Map();
  const built = tileParts.map((tp) => {
    const sopLens = [];
    const data = [], headers = [];
    for (const pk of tp.packets) {
      const n = sopCount.get(tp.tile) || 0;
      sopCount.set(tp.tile, n + 1);
      const sop = cfg.sop ? cat(u16(M.SOP), u16(4), u16(n & 0xffff)) : Buffer.alloc(0);
      const eph = cfg.eph ? Buffer.from(u16(M.EPH)) : Buffer.alloc(0);
      const header = cat(pk.header, eph);
      if (cfg.ppm || cfg.ppt) { data.push(sop, pk.body); headers.push(header); } else data.push(sop, header, pk.body);
      sopLens.push(sop.length + header.length + pk.body.length);
    }
    return { ...tp, body: cat(...data), headers, sopLens };
  });
  // tile-part headers
  const pptZ = new Map();
  const tpBufs = built.map((tp) => {
    const hdr = [];
    const over = (cfg.tiles || {})[tp.tile];
    if (tp.part === 0 && over && (over.prog !== undefined || over.layers !== undefined || over.levels !== undefined)) {
      const prog = over.prog ?? cfg.prog, layers = over.layers ?? cfg.layers;
      const prm = resolveComp(cfg, 0, tp.tile);
      hdr.push(segment(M.COD, [(prm.precincts ? 1 : 0) | (cfg.sop ? 2 : 0) | (cfg.eph ? 4 : 0), prog, ...u16(layers), cfg.mct ? 1 : 0, ...spcod(prm)]));
      if (over.levels !== undefined) hdr.push(segment(M.QCD, quantBytes(prm.quantResolved)));
      if (over.pocs) hdr.push(segment(M.POC, over.pocs.flatMap((p) => [p.res0, ...compIdx(cfg, p.comp0), ...u16(p.layer1), p.res1, ...compIdx(cfg, p.comp1), p.prog])));
    }
    if (cfg.plt) hdr.push(segment(M.PLT, [tp.part, ...tp.sopLens.flatMap(varint)]));
    if (cfg.ppt) {
      const all = cat(...tp.headers);
      for (let at = 0; at < all.length; at += 60000) {
        const z = pptZ.get(tp.tile) || 0;
        pptZ.set(tp.tile, z + 1);
        hdr.push(segment(M.PPT, [z, ...all.subarray(at, at + 60000)]));
      }
    }
    const hdrBuf = cat(...hdr);
    const psot = cfg.psotZeroLast && tp === built[built.length - 1] ? 0 : 12 + hdrBuf.length + 2 + tp.body.length;
    const tpCount = cfg.tnsot === false ? 0 : parts;
    return { buf: cat(u16(M.SOT), u16(10), u16(tp.tile), u32(psot), [tp.part, tpCount], hdrBuf, u16(M.SOD), tp.body), size: psot || 12 + hdrBuf.length + 2 + tp.body.length };
  });
  // main header
  const main = [u16(M.SOC)];
  main.push(segment(M.SIZ, [...u16(cfg.rsiz || 0), ...u32(cfg.X1), ...u32(cfg.Y1), ...u32(cfg.X0), ...u32(cfg.Y0), ...u32(cfg.tw), ...u32(cfg.th), ...u32(cfg.tx0), ...u32(cfg.ty0), ...u16(nComps), ...cfg.comps.flatMap((c) => [(c.signed ? 0x80 : 0) | (c.prec - 1), c.dx, c.dy])]));
  main.push(segment(M.COD, [(base.precincts ? 1 : 0) | (cfg.sop ? 2 : 0) | (cfg.eph ? 4 : 0), cfg.prog, ...u16(cfg.layers), cfg.mct ? 1 : 0, ...spcod(base)]));
  for (const [c, coc] of Object.entries(cfg.coc || {})) {
    const prm = resolveComp(cfg, +c, null);
    main.push(segment(M.COC, [...compIdx(cfg, +c), prm.precincts ? 1 : 0, ...spcod(prm)]));
  }
  main.push(segment(M.QCD, quantBytes(base.quantResolved)));
  for (const c of Object.keys(cfg.qcc || {})) main.push(segment(M.QCC, [...compIdx(cfg, +c), ...quantBytes(resolveComp(cfg, +c, null).quantResolved)]));
  for (const [c, shift] of Object.entries(cfg.rgn || {})) main.push(segment(M.RGN, [...compIdx(cfg, +c), 0, shift]));
  if (cfg.pocs) main.push(segment(M.POC, cfg.pocs.flatMap((p) => [p.res0, ...compIdx(cfg, p.comp0), ...u16(p.layer1), p.res1, ...compIdx(cfg, p.comp1), p.prog])));
  if (cfg.tlm) main.push(segment(M.TLM, [0, (2 << 4) | (1 << 6), ...tpBufs.flatMap((b, i) => [...u16(built[i].tile), ...u32(b.size)])]));
  if (cfg.ppm) {
    const limit = cfg.ppmChunk || 60000;
    const markers = [[]];
    const room = () => limit - markers[markers.length - 1].length;
    for (const tp of built) {
      const h = cat(...tp.headers);
      if (room() < 4) markers.push([]);
      markers[markers.length - 1].push(...u32(h.length));
      for (let at = 0; at < h.length;) {
        if (room() === 0) markers.push([]);
        const take = Math.min(room(), h.length - at);
        markers[markers.length - 1].push(...h.subarray(at, at + take));
        at += take;
      }
    }
    markers.forEach((m, z) => main.push(segment(M.PPM, [z, ...m])));
  }
  main.push(segment(M.COM, [0, 1, ...Buffer.from('mixdog jpx fixture')]));
  const out = cat(...main, ...tpBufs.map((b) => b.buf), cfg.noEoc ? Buffer.alloc(0) : u16(M.EOC));
  return { bytes: out, tiles, built, tpSizes: tpBufs.map((b) => b.size) };
}

// ---- JP2 wrapper --------------------------------------------------------------------------------------------------

const box = (type, body, opts = {}) => {
  const t = Buffer.from(type, 'latin1');
  if (opts.xl) return cat(u32(1), t, u32(0), u32(16 + body.length), body);
  if (opts.toEnd) return cat(u32(0), t, body);
  return cat(u32(8 + body.length), t, body);
};

function wrapJp2(cs, cfg) {
  const j = cfg.jp2;
  const parts = [box('jP  ', u32(0x0d0a870a)), box('ftyp', cat(Buffer.from('jp2 '), u32(0), Buffer.from('jp2 ')))];
  const sub = [box('ihdr', cat(u32(cfg.Y1 - cfg.Y0), u32(cfg.X1 - cfg.X0), u16(cfg.comps.length), [cfg.comps[0].prec - 1, 7, 0, 0]))];
  if (j.bpcc) sub.push(box('bpcc', Buffer.from(j.bpcc)));
  sub.push(j.icc ? box('colr', cat([2, 0, 0], Buffer.from(j.icc))) : box('colr', cat([1, 0, 0], u32(j.enumCs ?? 16))));
  if (j.palette) {
    const { entries, depths, values } = j.palette;
    sub.push(box('pclr', cat(u16(entries), [depths.length], depths, ...values.map((v, i) => Buffer.from([v])))));
    sub.push(box('cmap', cat(...j.cmap.map((m) => cat(u16(m[0]), [m[1], m[2]])))));
  }
  if (j.cdef) sub.push(box('cdef', cat(u16(j.cdef.length), ...j.cdef.map((d) => cat(u16(d[0]), u16(d[1]), u16(d[2]))))));
  if (j.res) sub.push(box('res ', cat(box('resc', cat(u16(7200), u16(1), [0], u16(7200), u16(1), [0])), box('resd', cat(u16(3000), u16(1), [1], u16(3000), u16(1), [1])))));
  parts.push(box('jp2h', cat(...sub)));
  if (j.junk) parts.push(box('xml ', Buffer.from('<x/>')), box('uuid', cat(Buffer.alloc(16, 7), Buffer.from('data'))));
  parts.push(box('jp2c', cs, { xl: j.xl, toEnd: j.toEnd }));
  return cat(...parts);
}

// ---- cases --------------------------------------------------------------------------------------------------------

const rgb = (extra = {}) => [{ prec: 8, dx: 1, dy: 1, ...extra }, { prec: 8, dx: 1, dy: 1, ...extra }, { prec: 8, dx: 1, dy: 1, ...extra }];
const defaults = { X0: 0, Y0: 0, tx0: 0, ty0: 0, levels: 3, cbw: 5, cbh: 5, reversible: true, quantStyle: 0, prog: 0, layers: 1, mct: 0, seed: 7 };
const mk = (o) => {
  const c = { ...defaults, ...o };
  c.X1 = c.X1 ?? c.X0 + c.W;
  c.Y1 = c.Y1 ?? c.Y0 + c.H;
  c.tw = c.tw ?? (c.X1 - c.tx0);
  c.th = c.th ?? (c.Y1 - c.ty0);
  return c;
};
const sub420 = [{ prec: 8, dx: 1, dy: 1 }, { prec: 8, dx: 2, dy: 2 }, { prec: 8, dx: 2, dy: 2 }];
const P32 = [[4, 4], [5, 5], [5, 5], [5, 5]];

const CASES = [
  mk({ name: 'gray-lossless', W: 64, H: 48, comps: [{ prec: 8, dx: 1, dy: 1 }], levels: 3, cbw: 4, cbh: 4 }),
  mk({ name: 'rgb-lossy-tiled', W: 100, H: 70, tw: 48, th: 40, comps: rgb(), levels: 2, cbw: 4, cbh: 4, reversible: false, quantStyle: 2, mct: 1, prog: 1, layers: 2 }),
  mk({ name: 'derived-quant', W: 40, H: 40, comps: rgb(), levels: 2, cbw: 4, cbh: 4, reversible: false, quantStyle: 1, mct: 1, layers: 3 }),
  mk({ name: 'rpcl-subsampled', W: 80, H: 64, comps: sub420, levels: 3, cbw: 4, cbh: 4, prog: 2, precincts: P32, layers: 2 }),
  mk({ name: 'pcrl-offset', X0: 5, Y0: 3, W: 77, H: 61, comps: sub420, levels: 3, cbw: 4, cbh: 4, prog: 3, precincts: P32, layers: 2 }),
  mk({ name: 'cprl-tiled', X0: 3, Y0: 2, W: 90, H: 70, tw: 64, th: 48, tx0: 1, ty0: 0, comps: sub420, levels: 3, cbw: 4, cbh: 4, prog: 4, precincts: P32, layers: 2 }),
  mk({ name: 'sop-eph', W: 64, H: 64, comps: rgb(), levels: 2, cbw: 4, cbh: 4, sop: true, eph: true, layers: 2 }),
  mk({ name: 'ppm-tileparts', W: 96, H: 64, tw: 48, th: 32, comps: rgb(), levels: 2, cbw: 4, cbh: 4, ppm: true, parts: 2, ppmChunk: 37, layers: 1, prog: 1 }),
  mk({ name: 'ppm-layers', W: 96, H: 64, tw: 48, th: 32, comps: rgb(), levels: 2, cbw: 4, cbh: 4, ppm: true, ppmChunk: 61, layers: 2, prog: 1 }),
  mk({ name: 'ppt-tlm-plt', W: 96, H: 64, tw: 48, th: 32, comps: rgb(), levels: 2, cbw: 4, cbh: 4, ppt: true, plt: true, tlm: true, parts: 3, layers: 3, eph: true }),
  mk({ name: 'poc', W: 64, H: 64, comps: rgb(), levels: 3, cbw: 4, cbh: 4, layers: 2, pocs: [{ res0: 0, res1: 2, comp0: 0, comp1: 3, layer1: 1, prog: 1 }, { res0: 0, res1: 4, comp0: 0, comp1: 3, layer1: 2, prog: 4 }] }),
  mk({ name: 'tile-cod-override', W: 64, H: 64, tw: 32, th: 64, comps: rgb(), levels: 2, cbw: 4, cbh: 4, layers: 2, tiles: { 1: { prog: 3, layers: 3, levels: 1 } }, precincts: [[4, 4], [5, 5], [5, 5]] }),
  mk({ name: 'cblk-styles', W: 48, H: 48, comps: [{ prec: 8, dx: 1, dy: 1 }], levels: 1, cbw: 4, cbh: 4, cbstyle: TERMALL, layers: 3 }),
  mk({ name: 'cblk-bypass', W: 48, H: 48, comps: [{ prec: 8, dx: 1, dy: 1 }], levels: 1, cbw: 4, cbh: 4, cbstyle: BYPASS, layers: 4, seed: 9 }),
  mk({ name: 'coc-qcc-rgn', W: 64, H: 48, comps: [{ prec: 12, signed: true, dx: 1, dy: 1 }, { prec: 8, dx: 1, dy: 1 }, { prec: 8, dx: 1, dy: 1 }], levels: 3, cbw: 5, cbh: 4, coc: { 1: { levels: 1, cbw: 4, cbh: 4 } }, qcc: { 2: { style: 2, guard: 3 } }, rgn: { 1: 5 }, prog: 1 }),
  mk({ name: 'wide-components', W: 8, H: 8, comps: Array.from({ length: 260 }, () => ({ prec: 8, dx: 1, dy: 1 })), levels: 0, cbw: 4, cbh: 4, coc: { 259: { levels: 1 } }, prog: 1 }),
  mk({ name: 'jp2-alpha', W: 32, H: 32, comps: [...rgb(), { prec: 8, dx: 1, dy: 1 }], levels: 1, cbw: 4, cbh: 4, mct: 1, jp2: { cdef: [[0, 0, 1], [1, 0, 2], [2, 0, 3], [3, 1, 0]], res: true, junk: true } }),
  mk({ name: 'jp2-palette-xl', W: 24, H: 24, comps: [{ prec: 8, dx: 1, dy: 1 }], levels: 1, cbw: 4, cbh: 4, jp2: { palette: { entries: 4, depths: [7, 7, 7], values: [0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255] }, cmap: [[0, 1, 0], [0, 1, 1], [0, 1, 2]], xl: true } }),
  mk({ name: 'jp2-icc-open-box', W: 24, H: 24, comps: [{ prec: 8, dx: 1, dy: 1 }], levels: 1, cbw: 4, cbh: 4, psotZeroLast: true, jp2: { icc: 'ICCPROFILE-STUB-0123456789', toEnd: true } }),
];

// ---- recorded structure -------------------------------------------------------------------------------------------

function describe(cfg, cs, jp2) {
  const base = resolveComp(cfg, 0, null);
  const comps = cfg.comps.map((c, i) => {
    const r = resolveComp(cfg, i, null);
    return { precision: c.prec, signed: !!c.signed, dx: c.dx, dy: c.dy, levels: r.levels, cbw: r.cbw, cbh: r.cbh, style: r.style, reversible: r.rev, precincts: r.precincts, roi: r.roi, quant: { style: r.quantResolved.style, guard: r.quantResolved.guard, steps: r.quantResolved.style === 1 ? [r.quantResolved.steps[0]] : r.quantResolved.steps }, effectiveSteps: Array.from({ length: 3 * r.levels + 1 }, (_, b) => r.effective(b)) };
  });
  const tiles = cs.tiles.map((tl) => {
    const over = (cfg.tiles || {})[tl.t] || {};
    const tileComps = tl.geo.comps.map((c) => ({
      x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1,
      res: c.res.map((r) => ({ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, pw: r.pw, ph: r.ph, bands: r.bands.map((b) => ({ orient: b.orient, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, numbps: b.numbps, expn: b.expn, mant: b.mant, precincts: b.precincts.map((p) => ({ x0: p.x0, y0: p.y0, x1: p.x1, y1: p.y1, cw: p.cw, ch: p.ch, blocks: p.blocks })) })) })),
    }));
    const blocks = [];
    for (const [key, ps] of tl.state) {
      const [, c, r, bi, k] = key.split('/').map(Number);
      const band = tl.geo.comps[c].res[r].bands[bi];
      ps.blocks.forEach((b, i) => {
        if (!b.segs.length) return;
        blocks.push({ comp: c, res: r, band: bi, precinct: k, index: i, numbps: band.numbps - b.zero, passes: b.passes, segments: b.segs.map((s) => [s.passes, s.len]), dataLen: b.segs.reduce((a, s) => a + s.len, 0) });
      });
    }
    return {
      index: tl.t, x0: tl.geo.x0, y0: tl.geo.y0, x1: tl.geo.x1, y1: tl.geo.y1,
      progression: over.prog ?? cfg.prog, layers: over.layers ?? cfg.layers,
      parts: cfg.parts || 1,
      components: tileComps,
      packets: tl.packets.map((p) => [...p.pk, p.empty ? 1 : 0, p.dataLen]),
      blocks,
    };
  });
  return {
    siz: { x1: cfg.X1, y1: cfg.Y1, x0: cfg.X0, y0: cfg.Y0, tileW: cfg.tw, tileH: cfg.th, tileX0: cfg.tx0, tileY0: cfg.ty0 },
    main: { progression: cfg.prog, layers: cfg.layers, mct: cfg.mct ? 1 : 0, sop: !!cfg.sop, eph: !!cfg.eph, pocs: cfg.pocs || [] },
    comps, tiles, tlm: cfg.tlm ? cs.built.map((tp, i) => ({ tile: tp.tile, length: cs.tpSizes[i] })) : null,
    plt: !!cfg.plt,
    jp2: cfg.jp2 ? { ...cfg.jp2 } : null,
    comment: 'mixdog jpx fixture',
  };
}

// ---- OpenJPEG through pdf.js --------------------------------------------------------------------------------------

async function openjpegResults(files) {
  const dec = await import(pathToFileURL(join(pdfjsDir, 'image_decoders', 'pdf.image_decoders.mjs')).href);
  const { JpxImage } = dec;
  const pkg = JSON.parse(readFileSync(join(pdfjsDir, 'package.json'), 'utf8'));
  const nodeDefault = {};
  const first = files[0];
  try {
    await JpxImage.instance.decode(new Uint8Array(first.bytes), { numComponents: first.comps });
    nodeDefault.error = null;
  } catch (e) { nodeDefault.error = String(e && e.message || e); }
  JpxImage.cleanup();
  const wasmDir = join(pdfjsDir, 'wasm');
  JpxImage.setOptions({
    useWasm: true, useWorkerFetch: false, wasmUrl: null,
    handler: { sendWithPromise: async (name, { filename }) => new Uint8Array(readFileSync(join(wasmDir, filename))) },
  });
  const results = {};
  for (const f of files) {
    try {
      const d = await JpxImage.instance.decode(new Uint8Array(f.bytes), { numComponents: f.comps });
      results[f.name] = { ok: true, pixelBytes: d.length };
    } catch (e) { results[f.name] = { error: String(e && e.message || e) }; }
    try {
      const props = JpxImage.parseImageProperties(new Uint8Array(f.codestream));
      results[f.name].properties = props;
    } catch (e) { results[f.name].propertiesError = String(e && e.message || e); }
  }
  return { version: pkg.version, nodeDefault, results };
}

// ---- main --------------------------------------------------------------------------------------------------------

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const expected = { generator: 'benchmarks/rust-core/recorders/record-office-jpx.mjs', cases: {} };
const files = [];
for (const cfg of CASES) {
  const cs = buildCodestream(cfg);
  const bytes = cfg.jp2 ? wrapJp2(cs.bytes, cfg) : cs.bytes;
  const file = `${cfg.name}.${cfg.jp2 ? 'jp2' : 'j2k'}`;
  writeFileSync(join(OUT, file), bytes);
  const info = describe(cfg, cs, cfg.jp2);
  expected.cases[cfg.name] = { file, bytes: bytes.length, ...info };
  files.push({ name: cfg.name, bytes, codestream: cs.bytes, comps: Math.min(cfg.comps.length, 4) });
}
const oj = await openjpegResults(files);
expected.pdfjs = { version: oj.version, nodeDefaultConfiguration: oj.nodeDefault };
for (const [name, r] of Object.entries(oj.results)) expected.cases[name].openjpeg = r;
writeFileSync(join(OUT, 'expected.json'), `${JSON.stringify(expected)}\n`);
const manifest = {
  set: 'office-jpx',
  recorder: 'benchmarks/rust-core/recorders/record-office-jpx.mjs',
  command: 'node benchmarks/rust-core/recorders/record-office-jpx.mjs',
  pdfjsDist: oj.version,
  nodeVersion: process.version,
  recorderSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
};
manifest.files = readdirSync(OUT).filter((f) => f !== 'MANIFEST.json').sort().map((f) => {
  const d = readFileSync(join(OUT, f));
  return { path: f, bytes: d.length, sha256: createHash('sha256').update(d).digest('hex') };
});
manifest.fileCount = manifest.files.length;
manifest.totalBytes = manifest.files.reduce((a, f) => a + f.bytes, 0);
writeFileSync(join(OUT, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${manifest.files.length} files to ${OUT}`);
