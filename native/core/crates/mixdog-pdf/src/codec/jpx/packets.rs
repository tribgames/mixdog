//! Tier-2 of JPEG 2000 (ITU-T T.800 annex B.9 to B.12): the packet progression orders (LRCP, RLCP, RPCL, PCRL, CPRL,
//! with progression order changes) and the packet headers with their tag trees, as OpenJPEG's `pi.c` and `t2.c`
//! read them.

use std::collections::HashSet;

use super::JpxError;
use super::markers::{
    CBLK_BYPASS, CBLK_TERMALL, EPH, Poc, Progression, SOP,
};
use super::tiles::{
    CodeBlock, PacketRecord, Segment, TileComponent, TileStructure, ceil_div, floor_div_pow2,
};

fn eof() -> JpxError {
    JpxError::new("the packet header runs past the end of the data")
}

/// MSB-first bit reader with the bit stuffing of packet headers: the byte after a 0xFF carries seven bits.
struct Bits<'a> {
    d: &'a [u8],
    pos: usize,
    buf: u32,
    ct: u32,
}

impl<'a> Bits<'a> {
    fn new(d: &'a [u8]) -> Self {
        Bits { d, pos: 0, buf: 0, ct: 0 }
    }

    fn byte_in(&mut self) -> Result<(), JpxError> {
        self.buf = (self.buf << 8) & 0xffff;
        self.ct = if self.buf == 0xff00 { 7 } else { 8 };
        let b = *self.d.get(self.pos).ok_or_else(eof)?;
        self.pos += 1;
        self.buf |= b as u32;
        Ok(())
    }

    fn bit(&mut self) -> Result<bool, JpxError> {
        if self.ct == 0 {
            self.byte_in()?;
        }
        self.ct -= 1;
        Ok((self.buf >> self.ct) & 1 == 1)
    }

    fn bits(&mut self, n: u32) -> Result<u32, JpxError> {
        let mut v = 0u32;
        for _ in 0..n {
            v = (v << 1) | self.bit()? as u32;
        }
        Ok(v)
    }

    /// Ends the header at a byte boundary; a last byte of 0xFF is followed by one stuffed byte.
    fn align(&mut self) -> Result<usize, JpxError> {
        if self.buf & 0xff == 0xff {
            self.ct = 7;
            self.byte_in()?;
        }
        self.ct = 0;
        Ok(self.pos)
    }
}

#[derive(Debug, Clone)]
struct TagNode {
    value: u32,
    low: u32,
    parent: u32,
}

/// A tag tree (annex B.10.2) over a `w` by `h` grid of leaves.
#[derive(Debug, Clone)]
pub(super) struct TagTree {
    nodes: Vec<TagNode>,
}

const NO_PARENT: u32 = u32::MAX;

impl TagTree {
    pub(super) fn new(w: u32, h: u32) -> Self {
        let mut nodes = Vec::new();
        if w == 0 || h == 0 {
            return TagTree { nodes };
        }
        let (mut lw, mut lh) = (w as usize, h as usize);
        let mut base = 0usize;
        loop {
            let level_size = lw * lh;
            let (nw, nh) = (lw.div_ceil(2), lh.div_ceil(2));
            let next_base = base + level_size;
            let last = lw == 1 && lh == 1;
            for y in 0..lh {
                for x in 0..lw {
                    let parent = if last { NO_PARENT } else { (next_base + (y / 2) * nw + x / 2) as u32 };
                    nodes.push(TagNode { value: u32::MAX, low: 0, parent });
                }
            }
            if last {
                break;
            }
            base = next_base;
            lw = nw;
            lh = nh;
        }
        TagTree { nodes }
    }

    /// Decodes down to `leaf` against `threshold`; true when the leaf's value is below the threshold.
    fn decode(&mut self, bits: &mut Bits, leaf: usize, threshold: u32) -> Result<bool, JpxError> {
        let mut path = Vec::with_capacity(34);
        let mut n = leaf;
        loop {
            path.push(n);
            let parent = self.nodes[n].parent;
            if parent == NO_PARENT {
                break;
            }
            n = parent as usize;
        }
        let mut low = 0u32;
        for &n in path.iter().rev() {
            let node = &mut self.nodes[n];
            if low > node.low {
                node.low = low;
            } else {
                low = node.low;
            }
            while low < threshold && low < node.value {
                if bits.bit()? {
                    node.value = low;
                } else {
                    low += 1;
                }
            }
            node.low = low;
        }
        Ok(self.nodes[leaf].value < threshold)
    }
}

/// `opj_t2_init_seg`: a new codeword segment and the number of passes it can hold.
fn new_segment(prev: Option<&Segment>, style: u8) -> Segment {
    let max_passes = if style & CBLK_TERMALL != 0 {
        1
    } else if style & CBLK_BYPASS != 0 {
        match prev {
            None => 10,
            Some(p) if p.max_passes == 1 || p.max_passes == 10 => 2,
            Some(_) => 1,
        }
    } else {
        109
    };
    Segment { passes: 0, max_passes, len: 0 }
}

fn pass_count(bits: &mut Bits) -> Result<u32, JpxError> {
    if !bits.bit()? {
        return Ok(1);
    }
    if !bits.bit()? {
        return Ok(2);
    }
    let v = bits.bits(2)?;
    if v != 3 {
        return Ok(3 + v);
    }
    let v = bits.bits(5)?;
    if v != 31 {
        return Ok(6 + v);
    }
    Ok(37 + bits.bits(7)?)
}

/// The sizes and passes one included code-block takes from a packet: `(band, block, [(segment, length)])`.
type Taken = (usize, usize, Vec<(usize, u32)>);

/// Reads one packet header (and applies the pass counts to the code-blocks); returns what the body must hold.
fn read_header(
    tile: &mut TileStructure,
    comp: usize,
    res: usize,
    precno: usize,
    layer: u32,
    bits: &mut Bits,
    taken: &mut Vec<Taken>,
) -> Result<bool, JpxError> {
    if !bits.bit()? {
        return Ok(false);
    }
    let style = tile.params.comps[comp].coding.style;
    let resolution = &mut tile.components[comp].resolutions[res];
    for (bi, band) in resolution.bands.iter_mut().enumerate() {
        let band_bps = band.numbps;
        let prc = &mut band.precincts[precno];
        for (ci, blk) in prc.blocks.iter_mut().enumerate() {
            let first = blk.segments.is_empty();
            let included = if first {
                prc.inclusion.decode(bits, ci, layer + 1)?
            } else {
                bits.bit()?
            };
            if !included {
                continue;
            }
            if first {
                let mut i = 1u32;
                while !prc.zero_planes.decode(bits, ci, i)? {
                    i += 1;
                    if i > 128 {
                        return Err(JpxError::new("invalid number of zero bit-planes"));
                    }
                }
                blk.numbps = band_bps + 1 - i as i32;
                blk.lblock = 3;
            }
            let mut left = pass_count(bits)?;
            while bits.bit()? {
                blk.lblock += 1;
                if blk.lblock > 32 {
                    return Err(JpxError::new("invalid code-block length indicator"));
                }
            }
            let mut idx = match blk.segments.len() {
                0 => {
                    blk.segments.push(new_segment(None, style));
                    0
                }
                n => {
                    if blk.segments[n - 1].passes == blk.segments[n - 1].max_passes {
                        let seg = new_segment(Some(&blk.segments[n - 1]), style);
                        blk.segments.push(seg);
                        n
                    } else {
                        n - 1
                    }
                }
            };
            let mut lens = Vec::new();
            loop {
                let seg = &mut blk.segments[idx];
                let take = (seg.max_passes - seg.passes).min(left);
                let width = blk.lblock + (31 - take.leading_zeros());
                if width > 32 {
                    return Err(JpxError::new("invalid code-block length indicator"));
                }
                let len = bits.bits(width)?;
                seg.passes += take;
                lens.push((idx, len));
                left -= take;
                blk.passes += take;
                if left == 0 {
                    break;
                }
                let seg = new_segment(Some(&blk.segments[idx]), style);
                blk.segments.push(seg);
                idx += 1;
            }
            taken.push((bi, ci, lens));
        }
    }
    Ok(true)
}

fn min_steps(c: &TileComponent) -> (u64, u64) {
    let n = c.resolutions.len();
    let mut sx = u64::MAX;
    let mut sy = u64::MAX;
    for (r, res) in c.resolutions.iter().enumerate() {
        let level = (n - 1 - r) as u32;
        sx = sx.min((c.dx as u64) << (res.ppx as u32 + level));
        sy = sy.min((c.dy as u64) << (res.ppy as u32 + level));
    }
    (sx, sy)
}

/// The precinct of resolution `r` of `c` whose first sample lies at the grid position `(x, y)`, or none when no
/// precinct starts there (`pi.c`).
fn precinct_at(t: &TileStructure, c: &TileComponent, r: usize, x: u64, y: u64) -> Option<u32> {
    let res = &c.resolutions[r];
    let level = (c.resolutions.len() - 1 - r) as u32;
    let (dx, dy) = (c.dx as u64, c.dy as u64);
    let (tx0, ty0, tx1, ty1) = (t.x0 as u64, t.y0 as u64, t.x1 as u64, t.y1 as u64);
    let (trx0, try0) = (ceil_div(tx0, dx << level), ceil_div(ty0, dy << level));
    let (trx1, try1) = (ceil_div(tx1, dx << level), ceil_div(ty1, dy << level));
    let (rpx, rpy) = (res.ppx as u32 + level, res.ppy as u32 + level);
    if !(y % (dy << rpy) == 0 || (y == ty0 && ((try0 << level) % (1u64 << rpy)) != 0)) {
        return None;
    }
    if !(x % (dx << rpx) == 0 || (x == tx0 && ((trx0 << level) % (1u64 << rpx)) != 0)) {
        return None;
    }
    if res.pw == 0 || res.ph == 0 || trx0 == trx1 || try0 == try1 {
        return None;
    }
    let prci = floor_div_pow2(ceil_div(x, dx << level) as i64, res.ppx as u32)
        - floor_div_pow2(trx0 as i64, res.ppx as u32);
    let prcj = floor_div_pow2(ceil_div(y, dy << level) as i64, res.ppy as u32)
        - floor_div_pow2(try0 as i64, res.ppy as u32);
    let precno = prci + prcj * res.pw as i64;
    if prci < 0 || prcj < 0 || precno >= (res.pw as i64) * (res.ph as i64) {
        return None;
    }
    Some(precno as u32)
}

/// Calls `f(layer, resolution, component, precinct)` for every packet of the progression `poc` names, stopping at
/// the first false.
fn run(t: &TileStructure, poc: &Poc, f: &mut dyn FnMut(u32, u32, u32, u32) -> bool) -> bool {
    let comps = &t.components;
    let (r0, r1) = (poc.res0, poc.res1);
    let (c0, c1) = (poc.comp0, poc.comp1);
    let layers = poc.layer1;
    let numres = |c: usize| comps[c].resolutions.len() as u32;
    let precincts = |c: usize, r: u32| {
        let res = &comps[c].resolutions[r as usize];
        res.pw * res.ph
    };
    match poc.progression {
        Progression::Lrcp => {
            for l in 0..layers {
                for r in r0..r1 {
                    for c in c0..c1 {
                        if r >= numres(c as usize) {
                            continue;
                        }
                        for p in 0..precincts(c as usize, r) {
                            if !f(l, r, c, p) {
                                return false;
                            }
                        }
                    }
                }
            }
        }
        Progression::Rlcp => {
            for r in r0..r1 {
                for l in 0..layers {
                    for c in c0..c1 {
                        if r >= numres(c as usize) {
                            continue;
                        }
                        for p in 0..precincts(c as usize, r) {
                            if !f(l, r, c, p) {
                                return false;
                            }
                        }
                    }
                }
            }
        }
        Progression::Rpcl => {
            let (mut sx, mut sy) = (u64::MAX, u64::MAX);
            for comp in comps {
                let (a, b) = min_steps(comp);
                sx = sx.min(a);
                sy = sy.min(b);
            }
            for r in r0..r1 {
                let mut y = t.y0 as u64;
                while y < t.y1 as u64 {
                    let mut x = t.x0 as u64;
                    while x < t.x1 as u64 {
                        for c in c0..c1 {
                            if r >= numres(c as usize) {
                                continue;
                            }
                            if let Some(p) = precinct_at(t, &comps[c as usize], r as usize, x, y) {
                                for l in 0..layers {
                                    if !f(l, r, c, p) {
                                        return false;
                                    }
                                }
                            }
                        }
                        x += sx - (x % sx);
                    }
                    y += sy - (y % sy);
                }
            }
        }
        Progression::Pcrl => {
            let (mut sx, mut sy) = (u64::MAX, u64::MAX);
            for comp in comps {
                let (a, b) = min_steps(comp);
                sx = sx.min(a);
                sy = sy.min(b);
            }
            let mut y = t.y0 as u64;
            while y < t.y1 as u64 {
                let mut x = t.x0 as u64;
                while x < t.x1 as u64 {
                    for c in c0..c1 {
                        for r in r0..r1.min(numres(c as usize)) {
                            if let Some(p) = precinct_at(t, &comps[c as usize], r as usize, x, y) {
                                for l in 0..layers {
                                    if !f(l, r, c, p) {
                                        return false;
                                    }
                                }
                            }
                        }
                    }
                    x += sx - (x % sx);
                }
                y += sy - (y % sy);
            }
        }
        Progression::Cprl => {
            for c in c0..c1 {
                let (sx, sy) = min_steps(&comps[c as usize]);
                let mut y = t.y0 as u64;
                while y < t.y1 as u64 {
                    let mut x = t.x0 as u64;
                    while x < t.x1 as u64 {
                        for r in r0..r1.min(numres(c as usize)) {
                            if let Some(p) = precinct_at(t, &comps[c as usize], r as usize, x, y) {
                                for l in 0..layers {
                                    if !f(l, r, c, p) {
                                        return false;
                                    }
                                }
                            }
                        }
                        x += sx - (x % sx);
                    }
                    y += sy - (y % sy);
                }
            }
        }
    }
    true
}

/// The progression changes of the tile, bounded by what the tile has; without POC one change covers everything.
fn progression_changes(t: &TileStructure) -> Vec<Poc> {
    let max_res = t.components.iter().map(|c| c.resolutions.len() as u32).max().unwrap_or(0);
    let comps = t.components.len() as u32;
    let layers = t.params.layers as u32;
    if t.params.pocs.is_empty() {
        return vec![Poc {
            res0: 0,
            comp0: 0,
            layer1: layers,
            res1: max_res,
            comp1: comps,
            progression: t.params.progression,
        }];
    }
    t.params
        .pocs
        .iter()
        .map(|p| Poc {
            res0: p.res0,
            comp0: p.comp0,
            layer1: p.layer1.min(layers),
            res1: p.res1.min(max_res),
            comp1: p.comp1.min(comps),
            progression: p.progression,
        })
        .collect()
}

/// The packet sequence of the tile as `(layer, resolution, component, precinct)`, a packet a later progression
/// change would repeat left out.
pub fn packet_order(t: &TileStructure) -> Vec<(u32, u32, u32, u32)> {
    let mut seen: HashSet<(u32, u32, u32, u32)> = HashSet::new();
    let mut out = Vec::new();
    for poc in progression_changes(t) {
        run(t, &poc, &mut |l, r, c, p| {
            if seen.insert((l, r, c, p)) {
                out.push((l, r, c, p));
            }
            true
        });
    }
    out
}

/// Reads every packet of the tile from `body` (and, with PPM or PPT, the packet headers from `packed`), filling in
/// the code-blocks. Data that ends early stops the reading and sets `truncated`; it is not an error. Returns the
/// bytes of `packed` the packet headers took.
pub(super) fn read_packets(
    tile: &mut TileStructure,
    body: &[u8],
    packed: Option<&[u8]>,
) -> Result<usize, JpxError> {
    let order = packet_order(tile);
    let sop = tile.params.sop;
    let eph = tile.params.eph;
    let mut bpos = 0usize;
    let mut hpos = 0usize;
    let mut taken: Vec<Taken> = Vec::new();
    for (layer, res, comp, precno) in order {
        let (c, r, p) = (comp as usize, res as usize, precno as usize);
        if sop && body.len() >= bpos + 6 && body[bpos..bpos + 2] == SOP.to_be_bytes() {
            bpos += 6;
        }
        let exhausted = match packed {
            Some(h) => hpos >= h.len(),
            None => bpos >= body.len(),
        };
        if exhausted {
            tile.truncated = true;
            break;
        }
        let src: &[u8] = match packed {
            Some(h) => &h[hpos..],
            None => &body[bpos..],
        };
        let mut bits = Bits::new(src);
        taken.clear();
        let parsed = read_header(tile, c, r, p, layer, &mut bits, &mut taken)
            .and_then(|nonempty| bits.align().map(|used| (nonempty, used)));
        let (nonempty, mut used) = match parsed {
            Ok(v) => v,
            Err(_) => {
                tile.truncated = true;
                break;
            }
        };
        if eph && src.len() >= used + 2 && src[used..used + 2] == EPH.to_be_bytes() {
            used += 2;
        }
        match packed {
            Some(_) => hpos += used,
            None => bpos += used,
        }
        let mut data_len = 0u32;
        let mut cut = false;
        for (bi, ci, lens) in &taken {
            let blk: &mut CodeBlock =
                &mut tile.components[c].resolutions[r].bands[*bi].precincts[p].blocks[*ci];
            for &(si, len) in lens {
                let avail = body.len().saturating_sub(bpos);
                let got = (len as usize).min(avail);
                blk.data.extend_from_slice(&body[bpos..bpos + got]);
                blk.segments[si].len += got as u32;
                bpos += got;
                data_len += got as u32;
                if got < len as usize {
                    cut = true;
                    break;
                }
            }
            if cut {
                break;
            }
        }
        tile.packets.push(PacketRecord {
            layer,
            resolution: res,
            component: comp,
            precinct: precno,
            empty: !nonempty,
            data_len,
        });
        if cut {
            tile.truncated = true;
            break;
        }
    }
    Ok(hpos)
}
