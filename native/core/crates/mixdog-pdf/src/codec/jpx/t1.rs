//! Tier-1 decoding of ITU-T T.800 annex D (EBCOT): the MQ arithmetic decoder and the three coding passes of a
//! code-block, with the code-block styles bypass, reset, termination on every pass, vertically causal contexts and
//! segmentation symbols, as OpenJPEG 2.5 (`t1.c`, `mqc.c`) decodes them.
//!
//! The decoded samples are kept the way OpenJPEG keeps them: twice the magnitude with the reconstruction midpoint
//! of the last decoded bit-plane included, signed; the dequantisation halves them. The MQ decoder is the one of
//! OpenJPEG (`mqc.c`: the standard's non-inverted software convention, two 0xFF sentinel bytes after every segment,
//! no end-of-data bookkeeping). It is not `codec::arith`'s: that one follows PDFium's JBIG2 conventions and has no
//! way to set a context's initial state, which tier-1 needs.

use super::JpxError;
use super::markers::{CBLK_BYPASS, CBLK_RESET, CBLK_SEGSYM, CBLK_VSC};
use super::tiles::CodeBlock;

/// One row of the probability estimation table (T.800 table C.2).
struct Qe {
    qe: u32,
    nmps: u8,
    nlps: u8,
    switch: bool,
}

const fn q(qe: u32, nmps: u8, nlps: u8, switch: u8) -> Qe {
    Qe { qe, nmps, nlps, switch: switch == 1 }
}

static QE_TABLE: [Qe; 47] = [
    q(0x5601, 1, 1, 1),
    q(0x3401, 2, 6, 0),
    q(0x1801, 3, 9, 0),
    q(0x0ac1, 4, 12, 0),
    q(0x0521, 5, 29, 0),
    q(0x0221, 38, 33, 0),
    q(0x5601, 7, 6, 1),
    q(0x5401, 8, 14, 0),
    q(0x4801, 9, 14, 0),
    q(0x3801, 10, 14, 0),
    q(0x3001, 11, 17, 0),
    q(0x2401, 12, 18, 0),
    q(0x1c01, 13, 20, 0),
    q(0x1601, 29, 21, 0),
    q(0x5601, 15, 14, 1),
    q(0x5401, 16, 14, 0),
    q(0x5101, 17, 15, 0),
    q(0x4801, 18, 16, 0),
    q(0x3801, 19, 17, 0),
    q(0x3401, 20, 18, 0),
    q(0x3001, 21, 19, 0),
    q(0x2801, 22, 19, 0),
    q(0x2401, 23, 20, 0),
    q(0x2201, 24, 21, 0),
    q(0x1c01, 25, 22, 0),
    q(0x1801, 26, 23, 0),
    q(0x1601, 27, 24, 0),
    q(0x1401, 28, 25, 0),
    q(0x1201, 29, 26, 0),
    q(0x1101, 30, 27, 0),
    q(0x0ac1, 31, 28, 0),
    q(0x09c1, 32, 29, 0),
    q(0x08a1, 33, 30, 0),
    q(0x0521, 34, 31, 0),
    q(0x0441, 35, 32, 0),
    q(0x02a1, 36, 33, 0),
    q(0x0221, 37, 34, 0),
    q(0x0141, 38, 35, 0),
    q(0x0111, 39, 36, 0),
    q(0x0085, 40, 37, 0),
    q(0x0049, 41, 38, 0),
    q(0x0025, 42, 39, 0),
    q(0x0015, 43, 40, 0),
    q(0x0009, 44, 41, 0),
    q(0x0005, 45, 42, 0),
    q(0x0001, 45, 43, 0),
    q(0x5601, 46, 46, 0),
];

/// Context numbers of OpenJPEG: zero coding 0..=8, sign coding 9..=13, magnitude refinement 14..=16, run-length
/// (aggregation) 17 and uniform 18.
const CTX_MAG: usize = 14;
const CTX_AGG: usize = 17;
const CTX_UNI: usize = 18;
const CONTEXTS: usize = 19;

/// A context: the index into the estimation table and the more probable symbol.
#[derive(Clone, Copy)]
struct Cx {
    state: u8,
    mps: u8,
}

fn reset_contexts() -> [Cx; CONTEXTS] {
    let mut c = [Cx { state: 0, mps: 0 }; CONTEXTS];
    c[0].state = 4;
    c[CTX_AGG].state = 3;
    c[CTX_UNI].state = 46;
    c
}

/// Sample flags of the code-block, with a border of one insignificant sample around it.
const SIG: u8 = 1;
const VISIT: u8 = 2;
const REFINED: u8 = 4;
const NEG: u8 = 8;

/// The most magnitude bit-planes a code-block may carry (OpenJPEG refuses 31 or more).
const MAX_BITPLANES: i32 = 31;

/// Tier-1 decoder state; one value is reused for every code-block of a tile.
pub struct Tier1 {
    w: usize,
    h: usize,
    flags: Vec<u8>,
    /// Twice the signed magnitude with the midpoint of the decoded bit-planes, `w * h` samples.
    data: Vec<i32>,
    ctx: [Cx; CONTEXTS],
    /// The bytes of the current segment followed by two 0xFF sentinels.
    seg: Vec<u8>,
    bp: usize,
    c: u32,
    a: u32,
    ct: u32,
}

impl Default for Tier1 {
    fn default() -> Self {
        Self::new()
    }
}

impl Tier1 {
    pub fn new() -> Self {
        Tier1 { w: 0, h: 0, flags: Vec::new(), data: Vec::new(), ctx: reset_contexts(), seg: Vec::new(), bp: 0, c: 0, a: 0, ct: 0 }
    }

    /// Decodes `block` of a sub-band with orientation `orient` (0 LL, 1 HL, 2 LH, 3 HH) coded with code-block style
    /// `style` and region-of-interest shift `roi_shift`; returns the samples, row after row, in the unit described at
    /// [`Tier1`] with the region-of-interest scaling already undone. Errors only for a block whose bit-plane count
    /// cannot be handled; data that ends early decodes as far as it goes.
    pub fn decode(&mut self, block: &CodeBlock, orient: u8, style: u8, roi_shift: u8) -> Result<&[i32], JpxError> {
        self.w = (block.x1 - block.x0) as usize;
        self.h = (block.y1 - block.y0) as usize;
        let stride = self.w + 2;
        self.flags.clear();
        self.flags.resize(stride * (self.h + 2), 0);
        self.data.clear();
        self.data.resize(self.w * self.h, 0);
        self.ctx = reset_contexts();

        let mut bpno1 = roi_shift as i32 + block.numbps;
        if bpno1 >= MAX_BITPLANES {
            return Err(JpxError::new("a code-block has too many bit-planes"));
        }
        let vsc = style & CBLK_VSC != 0;
        let mut passtype = 2u32;
        let mut offset = 0usize;
        for segment in &block.segments {
            let end = (offset + segment.len as usize).min(block.data.len());
            let bytes = &block.data[offset.min(end)..end];
            offset += segment.len as usize;
            let raw = bpno1 <= block.numbps - 4 && passtype < 2 && style & CBLK_BYPASS != 0;
            self.start_segment(bytes, raw);
            let mut pass = 0;
            while pass < segment.passes && bpno1 >= 1 {
                match passtype {
                    0 => self.sig_pass(bpno1, raw, vsc, orient),
                    1 => self.ref_pass(bpno1, raw, vsc),
                    _ => {
                        self.cleanup_pass(bpno1, vsc, orient);
                        if style & CBLK_SEGSYM != 0 {
                            // The segmentation symbol 1010; a deviation is only a warning in OpenJPEG.
                            for _ in 0..4 {
                                self.mq_decode(CTX_UNI);
                            }
                        }
                    }
                }
                if style & CBLK_RESET != 0 && !raw {
                    self.ctx = reset_contexts();
                }
                passtype += 1;
                if passtype == 3 {
                    passtype = 0;
                    bpno1 -= 1;
                }
                pass += 1;
            }
        }

        if roi_shift > 0 {
            if roi_shift >= 31 {
                self.data.fill(0);
            } else {
                let thresh = 1i32 << roi_shift;
                for v in &mut self.data {
                    let mag = v.abs();
                    if mag >= thresh {
                        let m = mag >> roi_shift;
                        *v = if *v < 0 { -m } else { m };
                    }
                }
            }
        }
        Ok(&self.data)
    }

    // ---- MQ and raw decoding ------------------------------------------------------------------------------------

    /// `opj_mqc_init_dec` / `opj_mqc_raw_init_dec`: both start from the bytes of the segment with the sentinels; a
    /// raw (bypass) segment starts with an empty register and reads its first byte with its first bit.
    fn start_segment(&mut self, bytes: &[u8], raw: bool) {
        self.seg.clear();
        self.seg.extend_from_slice(bytes);
        self.seg.extend_from_slice(&[0xFF, 0xFF]);
        self.bp = 0;
        if raw {
            self.c = 0;
            self.ct = 0;
            return;
        }
        self.c = if bytes.is_empty() { 0xFF << 16 } else { (bytes[0] as u32) << 16 };
        self.ct = 0;
        self.a = 0x8000;
        self.byte_in();
        self.c <<= 7;
        self.ct -= 7;
    }

    fn byte_in(&mut self) {
        let next = self.seg[self.bp + 1] as u32;
        if self.seg[self.bp] == 0xFF {
            if next > 0x8F {
                self.c = self.c.wrapping_add(0xFF00);
                self.ct = 8;
            } else {
                self.bp += 1;
                self.c = self.c.wrapping_add(next << 9);
                self.ct = 7;
            }
        } else {
            self.bp += 1;
            self.c = self.c.wrapping_add(next << 8);
            self.ct = 8;
        }
    }

    fn mq_decode(&mut self, ctxno: usize) -> u8 {
        let cx = self.ctx[ctxno];
        let entry = &QE_TABLE[cx.state as usize];
        self.a -= entry.qe;
        let d;
        if (self.c >> 16) < entry.qe {
            // LPS exchange.
            if self.a < entry.qe {
                d = cx.mps;
                self.ctx[ctxno].state = entry.nmps;
            } else {
                d = 1 - cx.mps;
                if entry.switch {
                    self.ctx[ctxno].mps = 1 - cx.mps;
                }
                self.ctx[ctxno].state = entry.nlps;
            }
            self.a = entry.qe;
        } else {
            self.c -= entry.qe << 16;
            if self.a & 0x8000 != 0 {
                return cx.mps;
            }
            // MPS exchange.
            if self.a < entry.qe {
                d = 1 - cx.mps;
                if entry.switch {
                    self.ctx[ctxno].mps = 1 - cx.mps;
                }
                self.ctx[ctxno].state = entry.nlps;
            } else {
                d = cx.mps;
                self.ctx[ctxno].state = entry.nmps;
            }
        }
        loop {
            if self.ct == 0 {
                self.byte_in();
            }
            self.a <<= 1;
            self.c <<= 1;
            self.ct -= 1;
            if self.a >= 0x8000 {
                break;
            }
        }
        d
    }

    /// `opj_mqc_raw_decode`: bits of a bypass segment, with the stuffed bit after a 0xFF byte.
    fn raw_decode(&mut self) -> u8 {
        if self.ct == 0 {
            if self.c == 0xFF {
                if self.seg[self.bp] > 0x8F {
                    self.c = 0xFF;
                    self.ct = 8;
                } else {
                    self.c = self.seg[self.bp] as u32;
                    self.bp += 1;
                    self.ct = 7;
                }
            } else {
                self.c = self.seg[self.bp] as u32;
                self.bp += 1;
                self.ct = 8;
            }
        }
        self.ct -= 1;
        ((self.c >> self.ct) & 1) as u8
    }

    // ---- contexts -----------------------------------------------------------------------------------------------

    fn index(&self, x: usize, y: usize) -> usize {
        (y + 1) * (self.w + 2) + x + 1
    }

    /// Significant neighbours `(horizontal, vertical, diagonal)` of the sample at `x, y`; with vertically causal
    /// contexts the sample in the last row of a stripe does not see the row below.
    fn neighbours(&self, x: usize, y: usize, vsc: bool) -> (u32, u32, u32) {
        let s = self.w + 2;
        let i = self.index(x, y);
        let sig = |j: usize| (self.flags[j] & SIG) as u32;
        let below = !(vsc && y & 3 == 3);
        let h = sig(i - 1) + sig(i + 1);
        let mut v = sig(i - s);
        let mut d = sig(i - s - 1) + sig(i - s + 1);
        if below {
            v += sig(i + s);
            d += sig(i + s - 1) + sig(i + s + 1);
        }
        (h, v, d)
    }

    fn zc_context(&self, x: usize, y: usize, vsc: bool, orient: u8) -> usize {
        let (mut h, mut v, d) = self.neighbours(x, y, vsc);
        if orient == 1 {
            std::mem::swap(&mut h, &mut v);
        }
        if orient == 3 {
            let hv = h + v;
            return match d {
                0 => match hv {
                    0 => 0,
                    1 => 1,
                    _ => 2,
                },
                1 => match hv {
                    0 => 3,
                    1 => 4,
                    _ => 5,
                },
                2 => {
                    if hv == 0 {
                        6
                    } else {
                        7
                    }
                }
                _ => 8,
            };
        }
        match h {
            2 => 8,
            1 => {
                if v >= 1 {
                    7
                } else if d >= 1 {
                    6
                } else {
                    5
                }
            }
            _ => match v {
                2 => 4,
                1 => 3,
                _ => match d {
                    0 => 0,
                    1 => 1,
                    _ => 2,
                },
            },
        }
    }

    /// Decodes the sign of a sample that just became significant: `true` for negative.
    fn sign(&mut self, x: usize, y: usize, vsc: bool, raw: bool) -> bool {
        if raw {
            return self.raw_decode() == 1;
        }
        let s = self.w + 2;
        let i = self.index(x, y);
        let contribution = |j: usize| -> i32 {
            let f = self.flags[j];
            if f & SIG == 0 {
                0
            } else if f & NEG != 0 {
                -1
            } else {
                1
            }
        };
        let south = if vsc && y & 3 == 3 { 0 } else { contribution(i + s) };
        let h = (contribution(i - 1) + contribution(i + 1)).clamp(-1, 1);
        let v = (contribution(i - s) + south).clamp(-1, 1);
        let (ctxno, xor) = match (h, v) {
            (1, 1) => (13, 0),
            (1, 0) => (12, 0),
            (1, -1) => (11, 0),
            (0, 1) => (10, 0),
            (0, 0) => (9, 0),
            (0, -1) => (10, 1),
            (-1, 1) => (11, 1),
            (-1, 0) => (12, 1),
            _ => (13, 1),
        };
        self.mq_decode(ctxno) ^ xor == 1
    }

    fn become_significant(&mut self, x: usize, y: usize, negative: bool, value: i32) {
        let i = self.index(x, y);
        self.data[y * self.w + x] = if negative { -value } else { value };
        self.flags[i] |= SIG | if negative { NEG } else { 0 };
    }

    // ---- the coding passes --------------------------------------------------------------------------------------

    fn sig_pass(&mut self, bpno1: i32, raw: bool, vsc: bool, orient: u8) {
        let one = 1i32 << bpno1;
        let oneplushalf = one | (one >> 1);
        for ys in (0..self.h).step_by(4) {
            for x in 0..self.w {
                for y in ys..(ys + 4).min(self.h) {
                    let i = self.index(x, y);
                    if self.flags[i] & (SIG | VISIT) != 0 {
                        continue;
                    }
                    let (h, v, d) = self.neighbours(x, y, vsc);
                    if h + v + d == 0 {
                        continue;
                    }
                    let bit = if raw { self.raw_decode() } else { self.mq_decode(self.zc_context(x, y, vsc, orient)) };
                    if bit == 1 {
                        let negative = self.sign(x, y, vsc, raw);
                        self.become_significant(x, y, negative, oneplushalf);
                    }
                    self.flags[i] |= VISIT;
                }
            }
        }
    }

    fn ref_pass(&mut self, bpno1: i32, raw: bool, vsc: bool) {
        let one = 1i32 << bpno1;
        let poshalf = one >> 1;
        for ys in (0..self.h).step_by(4) {
            for x in 0..self.w {
                for y in ys..(ys + 4).min(self.h) {
                    let i = self.index(x, y);
                    let f = self.flags[i];
                    if f & (SIG | VISIT) != SIG {
                        continue;
                    }
                    let bit = if raw {
                        self.raw_decode()
                    } else {
                        let ctxno = if f & REFINED != 0 {
                            CTX_MAG + 2
                        } else {
                            let (h, v, d) = self.neighbours(x, y, vsc);
                            if h + v + d > 0 { CTX_MAG + 1 } else { CTX_MAG }
                        };
                        self.mq_decode(ctxno)
                    };
                    let t = if bit == 1 { poshalf } else { -poshalf };
                    let sample = &mut self.data[y * self.w + x];
                    *sample += if *sample < 0 { -t } else { t };
                    self.flags[i] |= REFINED;
                }
            }
        }
    }

    fn cleanup_pass(&mut self, bpno1: i32, vsc: bool, orient: u8) {
        let one = 1i32 << bpno1;
        let oneplushalf = one | (one >> 1);
        for ys in (0..self.h).step_by(4) {
            for x in 0..self.w {
                let mut first = ys;
                if ys + 4 <= self.h {
                    let quiet = (ys..ys + 4).all(|y| {
                        let i = self.index(x, y);
                        let (h, v, d) = self.neighbours(x, y, vsc);
                        self.flags[i] & (SIG | VISIT) == 0 && h + v + d == 0
                    });
                    if quiet {
                        if self.mq_decode(CTX_AGG) == 0 {
                            continue;
                        }
                        let run = ((self.mq_decode(CTX_UNI) << 1) | self.mq_decode(CTX_UNI)) as usize;
                        let y = ys + run;
                        let negative = self.sign(x, y, vsc, false);
                        self.become_significant(x, y, negative, oneplushalf);
                        first = y + 1;
                    }
                }
                for y in first..(ys + 4).min(self.h) {
                    let i = self.index(x, y);
                    if self.flags[i] & (SIG | VISIT) != 0 {
                        continue;
                    }
                    if self.mq_decode(self.zc_context(x, y, vsc, orient)) == 1 {
                        let negative = self.sign(x, y, vsc, false);
                        self.become_significant(x, y, negative, oneplushalf);
                    }
                }
            }
        }
        for f in &mut self.flags {
            *f &= !VISIT;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::jpx::tiles::Segment;

    fn block(w: u32, h: u32, numbps: i32, passes: u32, data: &[u8]) -> CodeBlock {
        CodeBlock {
            x0: 0,
            y0: 0,
            x1: w,
            y1: h,
            numbps,
            lblock: 3,
            passes,
            segments: vec![Segment { passes, max_passes: 109, len: data.len() as u32 }],
            data: data.to_vec(),
        }
    }

    #[test]
    fn mq_decoder_follows_the_standard_test_sequence() {
        // The test sequence of T.88 annex H.2 (also the sequence of T.800 annex C): coded bytes and the decisions
        // they stand for, all in one context.
        let coded: [u8; 30] = [
            0x84, 0xC7, 0x3B, 0xFC, 0xE1, 0xA1, 0x43, 0x04, 0x02, 0x20, 0x00, 0x00, 0x41, 0x0D, 0xBB, 0x86, 0xF4, 0x31, 0x7F, 0xFF, 0x88, 0xFF, 0x37, 0x47,
            0x1A, 0xDB, 0x6A, 0xDF, 0xFF, 0xAC,
        ];
        let decoded: [u8; 32] = [
            0x00, 0x02, 0x00, 0x51, 0x00, 0x00, 0x00, 0xC0, 0x03, 0x52, 0x87, 0x2A, 0xAA, 0xAA, 0xAA, 0xAA, 0x82, 0xC0, 0x20, 0x00, 0xFC, 0xD7, 0x9E, 0xF6,
            0xBF, 0x7F, 0xED, 0x90, 0x4F, 0x46, 0xA3, 0xBF,
        ];
        let mut t1 = Tier1::new();
        t1.ctx = [Cx { state: 0, mps: 0 }; CONTEXTS];
        t1.start_segment(&coded, false);
        let mut out = [0u8; 32];
        for byte in &mut out {
            for bit in 0..8 {
                *byte |= t1.mq_decode(1) << (7 - bit);
            }
        }
        assert_eq!(out, decoded);
    }

    #[test]
    fn raw_decoder_skips_the_stuffed_bit_after_ff() {
        let mut t1 = Tier1::new();
        t1.start_segment(&[0xFF, 0x7F, 0x00], true);
        let bits: Vec<u8> = (0..16).map(|_| t1.raw_decode()).collect();
        assert_eq!(bits, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0]);
    }

    #[test]
    fn a_block_without_passes_is_zero_and_too_many_bit_planes_are_refused() {
        let mut t1 = Tier1::new();
        let b = block(4, 4, 5, 0, &[]);
        assert!(t1.decode(&b, 0, 0, 0).unwrap().iter().all(|&v| v == 0));
        let b = block(4, 4, 31, 1, &[0]);
        assert!(t1.decode(&b, 0, 0, 0).is_err());
        let b = block(4, 4, 20, 1, &[0]);
        assert!(t1.decode(&b, 0, 0, 11).is_err());
    }

    #[test]
    fn every_code_block_style_decodes_short_data_without_panicking() {
        let mut t1 = Tier1::new();
        for style in 0..0x40u8 {
            let b = block(7, 9, 6, 16, &[0x12, 0x34]);
            let out = t1.decode(&b, 3, style, 0).unwrap();
            assert_eq!(out.len(), 63);
        }
    }
}
