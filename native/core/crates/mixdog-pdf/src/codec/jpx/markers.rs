//! JPEG 2000 codestream marker segments (ITU-T T.800 annex A): SIZ, COD, COC, QCD, QCC, RGN, POC, PPM, PPT, TLM,
//! PLT, CRG, COM and SOT, and the parameter sets they build.
//!
//! The precedence of the coding parameters is the standard's and OpenJPEG's: a tile-part COC beats a tile-part COD,
//! which beats a main-header COC, which beats the main-header COD; quantisation follows the same order with QCC and
//! QCD.

use super::JpxError;

pub const SOC: u16 = 0xFF4F;
pub const SIZ: u16 = 0xFF51;
pub const COD: u16 = 0xFF52;
pub const COC: u16 = 0xFF53;
pub const TLM: u16 = 0xFF55;
pub const PLM: u16 = 0xFF57;
pub const PLT: u16 = 0xFF58;
pub const QCD: u16 = 0xFF5C;
pub const QCC: u16 = 0xFF5D;
pub const RGN: u16 = 0xFF5E;
pub const POC: u16 = 0xFF5F;
pub const PPM: u16 = 0xFF60;
pub const PPT: u16 = 0xFF61;
pub const CRG: u16 = 0xFF63;
pub const COM: u16 = 0xFF64;
pub const SOT: u16 = 0xFF90;
pub const SOP: u16 = 0xFF91;
pub const EPH: u16 = 0xFF92;
pub const SOD: u16 = 0xFF93;
pub const EOC: u16 = 0xFFD9;

/// Code-block style bits of the SPcod byte.
pub const CBLK_BYPASS: u8 = 0x01;
pub const CBLK_RESET: u8 = 0x02;
pub const CBLK_TERMALL: u8 = 0x04;
pub const CBLK_VSC: u8 = 0x08;
pub const CBLK_PREDICT: u8 = 0x10;
pub const CBLK_SEGSYM: u8 = 0x20;
/// Part 15 (HTJ2K) block coder bit: not supported.
pub const CBLK_HT: u8 = 0x40;

/// At most this many quantisation step sizes are kept (OpenJPEG `OPJ_J2K_MAXBANDS`).
const MAX_BANDS: usize = 97;
/// Largest sample precision the decoder handles.
const MAX_PRECISION: u8 = 31;
const MAX_COMPONENTS: usize = 16384;
const MAX_TILES: u64 = 65535;

fn bad(message: &str) -> JpxError {
    JpxError::new(message)
}

/// Big-endian reader over the body of one marker segment.
pub(super) struct Be<'a> {
    d: &'a [u8],
    p: usize,
}

impl<'a> Be<'a> {
    pub(super) fn new(d: &'a [u8]) -> Self {
        Be { d, p: 0 }
    }
    pub(super) fn left(&self) -> usize {
        self.d.len() - self.p
    }
    pub(super) fn u8(&mut self) -> Result<u8, JpxError> {
        let v = *self.d.get(self.p).ok_or_else(|| bad("marker segment too short"))?;
        self.p += 1;
        Ok(v)
    }
    pub(super) fn u16(&mut self) -> Result<u16, JpxError> {
        Ok(((self.u8()? as u16) << 8) | self.u8()? as u16)
    }
    pub(super) fn u32(&mut self) -> Result<u32, JpxError> {
        Ok(((self.u16()? as u32) << 16) | self.u16()? as u32)
    }
    pub(super) fn rest(&mut self) -> &'a [u8] {
        let r = &self.d[self.p..];
        self.p = self.d.len();
        r
    }
}

/// One marker segment found at `pos`: the marker, the bytes after its length field, and the position after it.
pub(super) fn read_segment(data: &[u8], pos: usize) -> Result<(u16, &[u8], usize), JpxError> {
    if pos + 4 > data.len() {
        return Err(bad("codestream ends inside a marker segment"));
    }
    let marker = u16::from_be_bytes([data[pos], data[pos + 1]]);
    let len = u16::from_be_bytes([data[pos + 2], data[pos + 3]]) as usize;
    if len < 2 {
        return Err(bad("marker segment length below 2"));
    }
    let end = pos + 2 + len;
    if end > data.len() {
        return Err(bad("codestream ends inside a marker segment"));
    }
    Ok((marker, &data[pos + 4..end], end))
}

/// Size of one component (SIZ `Ssiz`, `XRsiz`, `YRsiz`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompSiz {
    pub precision: u8,
    pub signed: bool,
    pub dx: u32,
    pub dy: u32,
}

/// The SIZ marker segment: the reference grid, the tile grid and the components.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Siz {
    pub rsiz: u16,
    pub x1: u32,
    pub y1: u32,
    pub x0: u32,
    pub y0: u32,
    pub tile_w: u32,
    pub tile_h: u32,
    pub tile_x0: u32,
    pub tile_y0: u32,
    pub comps: Vec<CompSiz>,
}

impl Siz {
    pub fn width(&self) -> u32 {
        self.x1 - self.x0
    }
    pub fn height(&self) -> u32 {
        self.y1 - self.y0
    }
    pub fn tiles_across(&self) -> u32 {
        (((self.x1 - self.tile_x0) as u64).div_ceil(self.tile_w as u64)) as u32
    }
    pub fn tiles_down(&self) -> u32 {
        (((self.y1 - self.tile_y0) as u64).div_ceil(self.tile_h as u64)) as u32
    }
    pub fn tile_count(&self) -> u32 {
        self.tiles_across() * self.tiles_down()
    }
}

pub(super) fn parse_siz(body: &[u8]) -> Result<Siz, JpxError> {
    let mut r = Be::new(body);
    let rsiz = r.u16()?;
    let x1 = r.u32()?;
    let y1 = r.u32()?;
    let x0 = r.u32()?;
    let y0 = r.u32()?;
    let tile_w = r.u32()?;
    let tile_h = r.u32()?;
    let tile_x0 = r.u32()?;
    let tile_y0 = r.u32()?;
    let csiz = r.u16()? as usize;
    if x1 == 0 || y1 == 0 || x0 >= x1 || y0 >= y1 {
        return Err(bad("invalid image size in SIZ"));
    }
    if tile_w == 0 || tile_h == 0 {
        return Err(bad("invalid tile size in SIZ"));
    }
    if tile_x0 > x0 || tile_y0 > y0 {
        return Err(bad("tile offset beyond the image offset in SIZ"));
    }
    if (tile_x0 as u64 + tile_w as u64) <= x0 as u64 || (tile_y0 as u64 + tile_h as u64) <= y0 as u64 {
        return Err(bad("the first tile does not cover the image origin in SIZ"));
    }
    if csiz == 0 || csiz > MAX_COMPONENTS {
        return Err(bad("invalid component count in SIZ"));
    }
    if r.left() < csiz * 3 {
        return Err(bad("SIZ is shorter than its component count"));
    }
    let mut comps = Vec::with_capacity(csiz);
    for _ in 0..csiz {
        let ssiz = r.u8()?;
        let dx = r.u8()? as u32;
        let dy = r.u8()? as u32;
        let precision = (ssiz & 0x7f) + 1;
        if precision > MAX_PRECISION || dx == 0 || dy == 0 {
            return Err(bad("invalid component parameters in SIZ"));
        }
        comps.push(CompSiz { precision, signed: ssiz & 0x80 != 0, dx, dy });
    }
    let siz = Siz { rsiz, x1, y1, x0, y0, tile_w, tile_h, tile_x0, tile_y0, comps };
    let tiles = siz.tiles_across() as u64 * siz.tiles_down() as u64;
    if tiles == 0 || tiles > MAX_TILES {
        return Err(bad("too many tiles in SIZ"));
    }
    Ok(siz)
}

/// Progression order of the packets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Progression {
    Lrcp,
    Rlcp,
    Rpcl,
    Pcrl,
    Cprl,
}

impl Progression {
    fn from_byte(b: u8) -> Result<Self, JpxError> {
        Ok(match b {
            0 => Progression::Lrcp,
            1 => Progression::Rlcp,
            2 => Progression::Rpcl,
            3 => Progression::Pcrl,
            4 => Progression::Cprl,
            _ => return Err(bad("unknown progression order")),
        })
    }
}

/// The coding style of one component (SPcod / SPcoc).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodingStyle {
    /// Decomposition levels; the component has `levels + 1` resolutions.
    pub levels: u8,
    /// Code-block width exponent (the marker's value plus 2).
    pub cbw: u8,
    pub cbh: u8,
    /// `CBLK_*` bits.
    pub style: u8,
    /// True for the reversible 5/3 transform, false for the irreversible 9/7.
    pub reversible: bool,
    /// Precinct size exponents `(PPx, PPy)` per resolution, lowest first.
    pub precincts: Vec<(u8, u8)>,
}

impl CodingStyle {
    fn placeholder() -> Self {
        CodingStyle { levels: 0, cbw: 6, cbh: 6, style: 0, reversible: true, precincts: vec![(15, 15)] }
    }
}

fn parse_spcod(r: &mut Be, has_precincts: bool) -> Result<CodingStyle, JpxError> {
    let levels = r.u8()?;
    let cbw = r.u8()? as u32 + 2;
    let cbh = r.u8()? as u32 + 2;
    let style = r.u8()?;
    let transform = r.u8()?;
    if levels > 32 {
        return Err(bad("more than 32 decomposition levels"));
    }
    if cbw > 10 || cbh > 10 || cbw + cbh > 12 {
        return Err(bad("invalid code-block size"));
    }
    if style & CBLK_HT != 0 {
        return Err(bad("high-throughput (Part 15) code-blocks are not supported"));
    }
    let mut precincts = Vec::with_capacity(levels as usize + 1);
    for i in 0..=levels {
        if has_precincts {
            let b = r.u8()?;
            let (ppx, ppy) = (b & 0x0f, b >> 4);
            if i != 0 && (ppx == 0 || ppy == 0) {
                return Err(bad("precinct exponent 0 above the lowest resolution"));
            }
            precincts.push((ppx, ppy));
        } else {
            precincts.push((15, 15));
        }
    }
    Ok(CodingStyle {
        levels,
        cbw: cbw as u8,
        cbh: cbh as u8,
        style,
        reversible: transform == 1,
        precincts,
    })
}

/// One quantisation step size: exponent and mantissa (the mantissa is 0 for no quantisation).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Step {
    pub expn: u8,
    pub mant: u16,
}

/// The quantisation of one component (Sqcd / Sqcc and SPqcd / SPqcc).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Quant {
    /// 0 no quantisation, 1 scalar derived, 2 (or any other value) scalar expounded.
    pub style: u8,
    pub guard: u8,
    steps: Vec<Step>,
}

impl Quant {
    fn placeholder() -> Self {
        Quant { style: 0, guard: 0, steps: Vec::new() }
    }

    /// The step of sub-band `bandno` (0 is LL, then HL, LH, HH of each resolution): derived quantisation computes it
    /// from the LL step; a band the marker did not carry has exponent 0 and mantissa 0, as OpenJPEG's zeroed array.
    pub fn step(&self, bandno: usize) -> Step {
        if self.style == 1 {
            let base = self.steps.first().copied().unwrap_or_default();
            if bandno == 0 {
                return base;
            }
            let drop = ((bandno - 1) / 3) as u32;
            return Step { expn: (base.expn as u32).saturating_sub(drop) as u8, mant: base.mant };
        }
        self.steps.get(bandno).copied().unwrap_or_default()
    }

    /// The step sizes exactly as the marker carried them.
    pub fn explicit_steps(&self) -> &[Step] {
        &self.steps
    }
}

fn parse_quant(r: &mut Be) -> Result<Quant, JpxError> {
    let s = r.u8()?;
    let style = s & 0x1f;
    let guard = s >> 5;
    let mut steps = Vec::new();
    match style {
        0 => {
            while r.left() >= 1 && steps.len() < MAX_BANDS {
                steps.push(Step { expn: r.u8()? >> 3, mant: 0 });
            }
        }
        1 => {
            let v = r.u16()?;
            steps.push(Step { expn: (v >> 11) as u8, mant: v & 0x7ff });
        }
        // 2 scalar expounded; OpenJPEG reads every other style value the same way.
        _ => {
            while r.left() >= 2 && steps.len() < MAX_BANDS {
                let v = r.u16()?;
                steps.push(Step { expn: (v >> 11) as u8, mant: v & 0x7ff });
            }
        }
    }
    Ok(Quant { style, guard, steps })
}

/// Everything the coding parameters of one component amount to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompParams {
    pub coding: CodingStyle,
    pub quant: Quant,
    /// Region-of-interest up-shift (RGN), 0 when there is none.
    pub roi_shift: u8,
}

/// One progression order change (POC entry).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Poc {
    pub res0: u32,
    pub comp0: u32,
    pub layer1: u32,
    pub res1: u32,
    pub comp1: u32,
    pub progression: Progression,
}

/// The parameters of the main header or of one tile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TileParams {
    pub progression: Progression,
    pub layers: u16,
    /// Multiple component transform: 0 none, 1 RCT/ICT.
    pub mct: u8,
    /// Start-of-packet markers may precede every packet.
    pub sop: bool,
    /// An end-of-packet-header marker follows every packet header.
    pub eph: bool,
    pub comps: Vec<CompParams>,
    pub pocs: Vec<Poc>,
}

/// A [`TileParams`] being assembled, with what is needed to apply the precedence of the markers.
#[derive(Debug, Clone)]
pub(super) struct ParamBuilder {
    pub params: TileParams,
    csiz: usize,
    coc_set: Vec<bool>,
    qcc_set: Vec<bool>,
    pub have_cod: bool,
    pub have_qcd: bool,
    /// True for a tile's builder: its first POC replaces the main header's list, the next ones add to it.
    in_tile: bool,
    poc_in_tile: bool,
}

impl ParamBuilder {
    pub(super) fn new(csiz: usize) -> Self {
        ParamBuilder {
            params: TileParams {
                progression: Progression::Lrcp,
                layers: 1,
                mct: 0,
                sop: false,
                eph: false,
                comps: vec![
                    CompParams {
                        coding: CodingStyle::placeholder(),
                        quant: Quant::placeholder(),
                        roi_shift: 0,
                    };
                    csiz
                ],
                pocs: Vec::new(),
            },
            csiz,
            coc_set: vec![false; csiz],
            qcc_set: vec![false; csiz],
            have_cod: false,
            have_qcd: false,
            in_tile: false,
            poc_in_tile: false,
        }
    }

    /// The builder a tile starts from: the main header's result, with the main COC/QCC no longer shielding a tile COD.
    pub(super) fn for_tile(&self) -> Self {
        let mut t = self.clone();
        t.coc_set.iter_mut().for_each(|f| *f = false);
        t.qcc_set.iter_mut().for_each(|f| *f = false);
        t.in_tile = true;
        t.poc_in_tile = false;
        t
    }

    fn comp_index(&self, r: &mut Be) -> Result<usize, JpxError> {
        let c = if self.csiz < 257 { r.u8()? as usize } else { r.u16()? as usize };
        if c >= self.csiz {
            return Err(bad("component index out of range"));
        }
        Ok(c)
    }

    /// Applies COD, COC, QCD, QCC, RGN or POC; any other marker is the caller's. Returns false when not handled.
    pub(super) fn apply(&mut self, marker: u16, body: &[u8]) -> Result<bool, JpxError> {
        let mut r = Be::new(body);
        match marker {
            COD => {
                let scod = r.u8()?;
                let prog = Progression::from_byte(r.u8()?)?;
                let layers = r.u16()?;
                let mct = r.u8()?;
                if layers == 0 {
                    return Err(bad("zero quality layers"));
                }
                let coding = parse_spcod(&mut r, scod & 1 != 0)?;
                self.params.progression = prog;
                self.params.layers = layers;
                self.params.mct = mct;
                self.params.sop = scod & 2 != 0;
                self.params.eph = scod & 4 != 0;
                for (c, comp) in self.params.comps.iter_mut().enumerate() {
                    if !self.coc_set[c] {
                        comp.coding = coding.clone();
                    }
                }
                self.have_cod = true;
            }
            COC => {
                let c = self.comp_index(&mut r)?;
                let scoc = r.u8()?;
                let coding = parse_spcod(&mut r, scoc & 1 != 0)?;
                self.params.comps[c].coding = coding;
                self.coc_set[c] = true;
            }
            QCD => {
                let q = parse_quant(&mut r)?;
                for (c, comp) in self.params.comps.iter_mut().enumerate() {
                    if !self.qcc_set[c] {
                        comp.quant = q.clone();
                    }
                }
                self.have_qcd = true;
            }
            QCC => {
                let c = self.comp_index(&mut r)?;
                self.params.comps[c].quant = parse_quant(&mut r)?;
                self.qcc_set[c] = true;
            }
            RGN => {
                let c = self.comp_index(&mut r)?;
                // Srgn: OpenJPEG reads the style without checking it; the shift applies whatever it says.
                r.u8()?;
                self.params.comps[c].roi_shift = r.u8()?;
            }
            POC => {
                if self.in_tile && !self.poc_in_tile {
                    self.params.pocs.clear();
                    self.poc_in_tile = true;
                }
                let wide = self.csiz >= 257;
                while r.left() > 0 {
                    let res0 = r.u8()? as u32;
                    let comp0 = if wide { r.u16()? as u32 } else { r.u8()? as u32 };
                    let layer1 = r.u16()? as u32;
                    let res1 = r.u8()? as u32;
                    let mut comp1 = if wide { r.u16()? as u32 } else { r.u8()? as u32 };
                    if !wide && comp1 == 0 {
                        comp1 = 256;
                    }
                    let progression = Progression::from_byte(r.u8()?)?;
                    self.params.pocs.push(Poc { res0, comp0, layer1, res1, comp1, progression });
                }
            }
            _ => return Ok(false),
        }
        Ok(true)
    }
}

/// One TLM entry: the tile (absent when the marker carries no tile indices: the tile-parts follow in order) and the
/// length of its tile-part.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TlmEntry {
    pub tile: Option<u16>,
    pub length: u32,
}

pub(super) fn parse_tlm(body: &[u8], out: &mut Vec<TlmEntry>) -> Result<(), JpxError> {
    let mut r = Be::new(body);
    let _ztlm = r.u8()?;
    let stlm = r.u8()?;
    let st = (stlm >> 4) & 3;
    let sp = (stlm >> 6) & 1;
    if st == 3 {
        return Err(bad("invalid TLM tile index size"));
    }
    while r.left() > 0 {
        let tile = match st {
            0 => None,
            1 => Some(r.u8()? as u16),
            _ => Some(r.u16()?),
        };
        let length = if sp == 0 { r.u16()? as u32 } else { r.u32()? };
        out.push(TlmEntry { tile, length });
    }
    Ok(())
}

/// A PLT segment's packet lengths (variable-length integers, seven bits per byte, the high bit continues).
pub(super) fn parse_plt(body: &[u8], out: &mut Vec<u32>) -> Result<(), JpxError> {
    let mut r = Be::new(body);
    let _zplt = r.u8()?;
    let mut value: u32 = 0;
    let mut open = false;
    while r.left() > 0 {
        let b = r.u8()?;
        if value >> 25 != 0 {
            return Err(bad("packet length overflow in PLT"));
        }
        value = (value << 7) | (b & 0x7f) as u32;
        if b & 0x80 != 0 {
            open = true;
        } else {
            out.push(value);
            value = 0;
            open = false;
        }
    }
    if open {
        return Err(bad("PLT ends inside a packet length"));
    }
    Ok(())
}

/// The SOT marker segment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sot {
    pub tile: u16,
    /// Length of the tile-part from the first byte of the SOT marker, 0 when it runs to the end of the codestream.
    pub length: u32,
    pub part: u8,
    /// Number of tile-parts of the tile, 0 when unknown.
    pub parts: u8,
}

pub(super) fn parse_sot(body: &[u8]) -> Result<Sot, JpxError> {
    let mut r = Be::new(body);
    Ok(Sot { tile: r.u16()?, length: r.u32()?, part: r.u8()?, parts: r.u8()? })
}

/// The main header: everything between SOC and the first SOT.
pub(super) struct MainHeader {
    pub siz: Siz,
    pub builder: ParamBuilder,
    pub tlm: Vec<TlmEntry>,
    pub comments: Vec<Vec<u8>>,
    pub crg: Option<Vec<u8>>,
    /// The PPM chunks, one per tile-part in codestream order.
    pub ppm: Option<Vec<Vec<u8>>>,
    /// Position of the first SOT marker.
    pub end: usize,
}

pub(super) fn read_main_header(data: &[u8]) -> Result<MainHeader, JpxError> {
    if data.len() < 2 || u16::from_be_bytes([data[0], data[1]]) != SOC {
        return Err(bad("the codestream does not begin with SOC"));
    }
    let (marker, body, mut pos) = read_segment(data, 2)?;
    if marker != SIZ {
        return Err(bad("SIZ does not follow SOC"));
    }
    let siz = parse_siz(body)?;
    let mut builder = ParamBuilder::new(siz.comps.len());
    let mut tlm = Vec::new();
    let mut comments = Vec::new();
    let mut crg = None;
    let mut ppm_parts: Vec<(u8, Vec<u8>)> = Vec::new();
    loop {
        if pos + 2 > data.len() {
            return Err(bad("the codestream ends inside its main header"));
        }
        let marker = u16::from_be_bytes([data[pos], data[pos + 1]]);
        if marker == SOT {
            break;
        }
        if marker >> 8 != 0xFF {
            return Err(bad("expected a marker in the main header"));
        }
        if (0xFF30..=0xFF3F).contains(&marker) {
            pos += 2;
            continue;
        }
        let (marker, body, next) = read_segment(data, pos)?;
        pos = next;
        if builder.apply(marker, body)? {
            continue;
        }
        match marker {
            TLM => parse_tlm(body, &mut tlm)?,
            PPM => {
                let mut r = Be::new(body);
                let z = r.u8()?;
                ppm_parts.push((z, r.rest().to_vec()));
            }
            CRG => crg = Some(body.to_vec()),
            COM => comments.push(body.to_vec()),
            // PLM and unknown markers carry nothing the decoder needs.
            _ => {}
        }
    }
    if !builder.have_cod {
        return Err(bad("the main header has no COD"));
    }
    if !builder.have_qcd {
        return Err(bad("the main header has no QCD"));
    }
    let ppm = if ppm_parts.is_empty() {
        None
    } else {
        ppm_parts.sort_by_key(|p| p.0);
        let all: Vec<u8> = ppm_parts.into_iter().flat_map(|p| p.1).collect();
        let mut chunks = Vec::new();
        let mut at = 0usize;
        while at + 4 <= all.len() {
            let n = u32::from_be_bytes([all[at], all[at + 1], all[at + 2], all[at + 3]]) as usize;
            at += 4;
            let end = at.saturating_add(n).min(all.len());
            chunks.push(all[at..end].to_vec());
            at = end;
        }
        Some(chunks)
    };
    Ok(MainHeader { siz, builder, tlm, comments, crg, ppm, end: pos })
}
