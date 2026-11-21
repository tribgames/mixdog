//! Tile-part assembly and the tile geometry of ITU-T T.800 annex B: tiles, tile-components, resolutions, sub-bands,
//! precincts and code-blocks, with the coordinates OpenJPEG computes (`opj_tcd_init_tile`).

use std::ops::Range;

use super::JpxError;
use super::markers::{self, CompParams, EOC, MainHeader, ParamBuilder, SOD, SOT, Siz, TileParams, parse_plt, read_segment};
use super::packets::TagTree;

/// Most precincts and code-blocks one tile may hold; a header that asks for more is refused instead of allocated.
const MAX_PRECINCTS: u64 = 1 << 24;
const MAX_BLOCKS: u64 = 1 << 24;

pub(super) fn ceil_div(a: u64, b: u64) -> u64 {
    a.div_ceil(b)
}

pub(super) fn ceil_div_pow2(a: i64, b: u32) -> i64 {
    (a + ((1i64 << b) - 1)) >> b
}

pub(super) fn floor_div_pow2(a: i64, b: u32) -> i64 {
    a >> b
}

/// What the tile-parts of one tile contributed, before any packet is read.
pub(super) struct TileEntry {
    pub builder: ParamBuilder,
    /// Packet data of each tile-part, in codestream order.
    pub bodies: Vec<Range<usize>>,
    /// The packed packet headers (PPM or PPT) of the tile, when it has them.
    pub packed: Option<Vec<u8>>,
    /// The packet headers the tile reads when the PPM headers of all tile-parts are one stream the tiles take from in
    /// the order OpenJPEG decodes them (see `Codestream::decoded_tile`); `None` without PPM.
    pub stream_packed: Option<Vec<u8>>,
    /// Packet lengths of the PLT markers.
    pub packet_lengths: Vec<u32>,
    pub parts: u32,
    /// The position, among all tile-parts of the codestream, of the tile's last one.
    pub last_part: usize,
}

/// Reads every tile-part header from the first SOT, in codestream order. Stops without an error at the end of the
/// data, at an EOC, or at a position that is not a SOT (damaged or truncated streams decode as far as they go);
/// the second value tells that the codestream ended early.
pub(super) fn assemble(data: &[u8], head: &MainHeader) -> Result<(Vec<Option<TileEntry>>, bool), JpxError> {
    let tile_count = head.siz.tile_count() as usize;
    let mut tiles: Vec<Option<TileEntry>> = (0..tile_count).map(|_| None).collect();
    let mut pos = head.end;
    let mut sequence = 0usize;
    let mut truncated = false;
    loop {
        if pos + 2 > data.len() {
            truncated = true;
            break;
        }
        let marker = u16::from_be_bytes([data[pos], data[pos + 1]]);
        if marker == EOC {
            break;
        }
        if marker != SOT {
            truncated = true;
            break;
        }
        let Ok((_, body, mut next)) = read_segment(data, pos) else {
            truncated = true;
            break;
        };
        if body.len() < 8 {
            return Err(JpxError::new("SOT is shorter than its fields"));
        }
        let sot = markers::parse_sot(body)?;
        let index = sot.tile as usize;
        if index >= tile_count {
            return Err(JpxError::new("tile index of SOT beyond the tile grid"));
        }
        let part_end = tile_part_end(data, &sot, pos, next, &mut truncated)?;
        let entry = tiles[index].get_or_insert_with(|| TileEntry {
            builder: head.builder.for_tile(),
            bodies: Vec::new(),
            packed: None,
            stream_packed: None,
            packet_lengths: Vec::new(),
            parts: 0,
            last_part: 0,
        });
        let mut ppt = read_part_header(data, &mut next, entry)?;
        if part_end < next {
            return Err(JpxError::new("a tile-part is shorter than its header"));
        }
        entry.bodies.push(next..part_end);
        entry.parts += 1;
        if let Some(chunks) = &head.ppm {
            let packed = entry.packed.get_or_insert_with(Vec::new);
            if let Some(chunk) = chunks.get(sequence) {
                packed.extend_from_slice(chunk);
            }
        }
        entry.last_part = sequence;
        if !ppt.is_empty() {
            ppt.sort_by_key(|p| p.0);
            let packed = entry.packed.get_or_insert_with(Vec::new);
            for (_, bytes) in ppt {
                packed.extend_from_slice(&bytes);
            }
        }
        sequence += 1;
        pos = part_end;
    }
    Ok((tiles, truncated))
}

/// Where the tile-part of `sot`, whose SOT marker is at `pos` and whose header ends after `next`, ends. A length that
/// runs past the data is cut to it and sets `truncated`; a length of 0 runs to the end (before a closing EOC).
fn tile_part_end(data: &[u8], sot: &markers::Sot, pos: usize, next: usize, truncated: &mut bool) -> Result<usize, JpxError> {
    if sot.length == 0 {
        let mut e = data.len();
        if e >= next + 2 && data[e - 2..] == EOC.to_be_bytes() {
            e -= 2;
        }
        return Ok(e);
    }
    if sot.length < 12 {
        return Err(JpxError::new("tile-part length below 12"));
    }
    let e = pos as u64 + sot.length as u64;
    if e > data.len() as u64 {
        *truncated = true;
    }
    Ok(e.min(data.len() as u64) as usize)
}

/// Reads the marker segments of a tile-part header from `next` up to and past its SOD, applying the coding
/// parameters to `entry`; returns the PPT segments `(index, data)`.
fn read_part_header(data: &[u8], next: &mut usize, entry: &mut TileEntry) -> Result<Vec<(u8, Vec<u8>)>, JpxError> {
    let mut ppt: Vec<(u8, Vec<u8>)> = Vec::new();
    loop {
        if *next + 2 > data.len() {
            return Err(JpxError::new("the codestream ends inside a tile-part header"));
        }
        if u16::from_be_bytes([data[*next], data[*next + 1]]) == SOD {
            *next += 2;
            return Ok(ppt);
        }
        let (m, seg, after) = read_segment(data, *next)?;
        *next = after;
        if entry.builder.apply(m, seg)? {
            continue;
        }
        match m {
            markers::PPT => {
                let mut r = markers::Be::new(seg);
                let z = r.u8()?;
                ppt.push((z, r.rest().to_vec()));
            }
            markers::PLT => parse_plt(seg, &mut entry.packet_lengths)?,
            _ => {}
        }
    }
}

/// One segment of a code-block: the passes that end at one codeword-segment termination and its bytes so far.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    pub passes: u32,
    pub max_passes: u32,
    /// Bytes of the segment present in the codestream.
    pub len: u32,
}

/// One code-block with what the packets contributed to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeBlock {
    pub x0: u32,
    pub y0: u32,
    pub x1: u32,
    pub y1: u32,
    /// Number of magnitude bit-planes of the block (the sub-band's, minus the zero bit-planes the first
    /// inclusion declared); meaningful once `segments` is not empty.
    pub numbps: i32,
    pub(super) lblock: u32,
    /// Coding passes received over all layers.
    pub passes: u32,
    pub segments: Vec<Segment>,
    /// The bytes of all segments, in order.
    pub data: Vec<u8>,
}

/// The part of one precinct that lies in one sub-band.
#[derive(Debug, Clone)]
pub struct Precinct {
    pub x0: u32,
    pub y0: u32,
    pub x1: u32,
    pub y1: u32,
    /// Code-blocks across and down.
    pub cw: u32,
    pub ch: u32,
    pub blocks: Vec<CodeBlock>,
    pub(super) inclusion: TagTree,
    pub(super) zero_planes: TagTree,
}

/// One sub-band of a resolution.
#[derive(Debug, Clone)]
pub struct Band {
    /// 0 LL, 1 HL, 2 LH, 3 HH.
    pub orient: u8,
    pub x0: u32,
    pub y0: u32,
    pub x1: u32,
    pub y1: u32,
    /// Magnitude bit-planes of the band: exponent plus guard bits minus one.
    pub numbps: i32,
    pub expn: u8,
    pub mant: u16,
    /// The dequantisation step as OpenJPEG computes it (`stepsize`).
    pub stepsize: f32,
    /// One entry per precinct of the resolution.
    pub precincts: Vec<Precinct>,
}

/// One resolution level of a tile-component.
#[derive(Debug, Clone)]
pub struct Resolution {
    pub x0: u32,
    pub y0: u32,
    pub x1: u32,
    pub y1: u32,
    /// Precinct size exponents.
    pub ppx: u8,
    pub ppy: u8,
    /// Precincts across and down.
    pub pw: u32,
    pub ph: u32,
    pub bands: Vec<Band>,
}

/// One component of a tile.
#[derive(Debug, Clone)]
pub struct TileComponent {
    pub dx: u32,
    pub dy: u32,
    pub x0: u32,
    pub y0: u32,
    pub x1: u32,
    pub y1: u32,
    pub resolutions: Vec<Resolution>,
}

/// One packet of the tile in the order the stream carries it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PacketRecord {
    pub layer: u32,
    pub resolution: u32,
    pub component: u32,
    pub precinct: u32,
    /// The packet header said the packet is empty.
    pub empty: bool,
    /// Bytes of code-block data the packet carried.
    pub data_len: u32,
}

/// A tile with its geometry and, once the packets are read, the code-block contributions.
#[derive(Debug, Clone)]
pub struct TileStructure {
    pub index: u32,
    pub x0: u32,
    pub y0: u32,
    pub x1: u32,
    pub y1: u32,
    pub params: TileParams,
    pub components: Vec<TileComponent>,
    pub packets: Vec<PacketRecord>,
    /// The tile data ended (or a header could not be read) before every packet was seen.
    pub truncated: bool,
}

/// The geometry of tile `index`: no packet has been read yet.
pub(super) fn build_tile(siz: &Siz, index: u32, params: &TileParams) -> Result<TileStructure, JpxError> {
    let across = siz.tiles_across() as u64;
    let p = index as u64 % across;
    let q = index as u64 / across;
    let tx0 = (siz.tile_x0 as u64 + p * siz.tile_w as u64).max(siz.x0 as u64);
    let ty0 = (siz.tile_y0 as u64 + q * siz.tile_h as u64).max(siz.y0 as u64);
    let tx1 = (siz.tile_x0 as u64 + (p + 1) * siz.tile_w as u64).min(siz.x1 as u64);
    let ty1 = (siz.tile_y0 as u64 + (q + 1) * siz.tile_h as u64).min(siz.y1 as u64);
    let mut precinct_total = 0u64;
    let mut block_total = 0u64;
    let mut components = Vec::with_capacity(siz.comps.len());
    for (c, cs) in siz.comps.iter().enumerate() {
        let cp = &params.comps[c];
        let (dx, dy) = (cs.dx as u64, cs.dy as u64);
        let (cx0, cy0) = (ceil_div(tx0, dx) as i64, ceil_div(ty0, dy) as i64);
        let (cx1, cy1) = (ceil_div(tx1, dx) as i64, ceil_div(ty1, dy) as i64);
        let numres = cp.coding.levels as u32 + 1;
        let mut resolutions = Vec::with_capacity(numres as usize);
        for r in 0..numres {
            let res = build_resolution(cs.precision, cp, r, numres, (cx0, cy0, cx1, cy1), &mut precinct_total, &mut block_total)?;
            resolutions.push(res);
        }
        components.push(TileComponent { dx: cs.dx, dy: cs.dy, x0: cx0 as u32, y0: cy0 as u32, x1: cx1 as u32, y1: cy1 as u32, resolutions });
    }
    Ok(TileStructure {
        index,
        x0: tx0 as u32,
        y0: ty0 as u32,
        x1: tx1 as u32,
        y1: ty1 as u32,
        params: params.clone(),
        components,
        packets: Vec::new(),
        truncated: false,
    })
}

/// The precinct where the precinct grid cell `grid` (`x0, y0, x1, y1`) meets the band `band`, split into code-blocks
/// of `2^cb.0 x 2^cb.1`; `block_total` counts the blocks of the tile.
fn build_precinct(grid: (i64, i64, i64, i64), band: (i64, i64, i64, i64), cb: (u32, u32), block_total: &mut u64) -> Result<Precinct, JpxError> {
    let (cbw, cbh) = cb;
    let px0 = grid.0.max(band.0);
    let py0 = grid.1.max(band.1);
    let px1 = grid.2.min(band.2);
    let py1 = grid.3.min(band.3);
    let (mut cw, mut ch) = (0u64, 0u64);
    let (mut tlbx, mut tlby) = (0i64, 0i64);
    if px1 > px0 && py1 > py0 {
        tlbx = floor_div_pow2(px0, cbw) << cbw;
        tlby = floor_div_pow2(py0, cbh) << cbh;
        let brbx = ceil_div_pow2(px1, cbw) << cbw;
        let brby = ceil_div_pow2(py1, cbh) << cbh;
        cw = ((brbx - tlbx) >> cbw) as u64;
        ch = ((brby - tlby) >> cbh) as u64;
    }
    *block_total += cw * ch;
    if *block_total > MAX_BLOCKS {
        return Err(JpxError::new("the tile has too many code-blocks"));
    }
    let mut blocks = Vec::with_capacity((cw * ch) as usize);
    for n in 0..cw * ch {
        let sx = tlbx + ((n % cw) as i64) * (1i64 << cbw);
        let sy = tlby + ((n / cw) as i64) * (1i64 << cbh);
        blocks.push(CodeBlock {
            x0: sx.max(px0) as u32,
            y0: sy.max(py0) as u32,
            x1: (sx + (1i64 << cbw)).min(px1) as u32,
            y1: (sy + (1i64 << cbh)).min(py1) as u32,
            numbps: 0,
            lblock: 3,
            passes: 0,
            segments: Vec::new(),
            data: Vec::new(),
        });
    }
    Ok(Precinct {
        x0: px0.max(0) as u32,
        y0: py0.max(0) as u32,
        x1: px1.max(0) as u32,
        y1: py1.max(0) as u32,
        cw: cw as u32,
        ch: ch as u32,
        blocks,
        inclusion: TagTree::new(cw as u32, ch as u32),
        zero_planes: TagTree::new(cw as u32, ch as u32),
    })
}

fn build_resolution(
    precision: u8,
    cp: &CompParams,
    r: u32,
    numres: u32,
    tc: (i64, i64, i64, i64),
    precinct_total: &mut u64,
    block_total: &mut u64,
) -> Result<Resolution, JpxError> {
    let (cx0, cy0, cx1, cy1) = tc;
    let level = numres - 1 - r;
    let (rx0, ry0) = (ceil_div_pow2(cx0, level), ceil_div_pow2(cy0, level));
    let (rx1, ry1) = (ceil_div_pow2(cx1, level), ceil_div_pow2(cy1, level));
    let (ppx, ppy) = cp.coding.precincts[r as usize];
    let (ppx32, ppy32) = (ppx as u32, ppy as u32);
    let tlx = floor_div_pow2(rx0, ppx32) << ppx32;
    let tly = floor_div_pow2(ry0, ppy32) << ppy32;
    let brx = ceil_div_pow2(rx1, ppx32) << ppx32;
    let bry = ceil_div_pow2(ry1, ppy32) << ppy32;
    let pw = if rx0 == rx1 { 0 } else { ((brx - tlx) >> ppx32) as u64 };
    let ph = if ry0 == ry1 { 0 } else { ((bry - tly) >> ppy32) as u64 };
    *precinct_total += pw * ph;
    if *precinct_total > MAX_PRECINCTS {
        return Err(JpxError::new("the tile has too many precincts"));
    }
    let orients: &[u8] = if r == 0 { &[0] } else { &[1, 2, 3] };
    let mut bands = Vec::with_capacity(orients.len());
    for &orient in orients {
        let (bx0, by0, bx1, by1) = if r == 0 {
            (rx0, ry0, rx1, ry1)
        } else {
            let (xb, yb) = ((orient & 1) as i64, (orient >> 1) as i64);
            (
                ceil_div_pow2(cx0 - (xb << level), level + 1),
                ceil_div_pow2(cy0 - (yb << level), level + 1),
                ceil_div_pow2(cx1 - (xb << level), level + 1),
                ceil_div_pow2(cy1 - (yb << level), level + 1),
            )
        };
        let band_index = if r == 0 { 0 } else { 3 * (r as usize - 1) + orient as usize };
        let step = cp.quant.step(band_index);
        // Equations E-3 and E-4; the irreversible path uses a nominal gain of 0 as OpenJPEG's decoder does.
        let log2_gain: i32 = if !cp.coding.reversible || orient == 0 {
            0
        } else if orient == 3 {
            2
        } else {
            1
        };
        let rb = precision as i32 + log2_gain;
        let stepsize = ((1.0 + step.mant as f64 / 2048.0) * 2f64.powi(rb - step.expn as i32)) as f32;
        let numbps = step.expn as i32 + cp.quant.guard as i32 - 1;

        let (cbg_w, cbg_h) = if r == 0 { (ppx32, ppy32) } else { (ppx32 - 1, ppy32 - 1) };
        let (tl_cbg_x, tl_cbg_y) = if r == 0 { (tlx, tly) } else { (ceil_div_pow2(tlx, 1), ceil_div_pow2(tly, 1)) };
        let cbw = (cp.coding.cbw as u32).min(cbg_w);
        let cbh = (cp.coding.cbh as u32).min(cbg_h);
        let mut precincts = Vec::with_capacity((pw * ph) as usize);
        for precno in 0..pw * ph {
            let gx = tl_cbg_x + ((precno % pw) as i64) * (1i64 << cbg_w);
            let gy = tl_cbg_y + ((precno / pw) as i64) * (1i64 << cbg_h);
            let grid = (gx, gy, gx + (1i64 << cbg_w), gy + (1i64 << cbg_h));
            precincts.push(build_precinct(grid, (bx0, by0, bx1, by1), (cbw, cbh), block_total)?);
        }
        bands.push(Band {
            orient,
            x0: bx0.max(0) as u32,
            y0: by0.max(0) as u32,
            x1: bx1.max(0) as u32,
            y1: by1.max(0) as u32,
            numbps,
            expn: step.expn,
            mant: step.mant,
            stepsize,
            precincts,
        });
    }
    Ok(Resolution { x0: rx0 as u32, y0: ry0 as u32, x1: rx1 as u32, y1: ry1 as u32, ppx, ppy, pw: pw as u32, ph: ph as u32, bands })
}
