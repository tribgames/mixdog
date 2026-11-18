//! Text region decoding (T.88 6.4, PDFium's `CJBig2_TRDProc`) in both coding modes, the text region segment (types 4, 6
//! and 7), and the symbol-id Huffman table of a Huffman coded text region (T.88 7.4.3.1.7).

use super::huffman::{Code, HuffmanTable, assigned};
use super::image::{ComposeOp, Image};
use super::refine::{self, RefinementRegion};
use super::symbols::Symbol;
use super::{BitStream, Context, Failure, Flow, Segment, SegmentResult, find_segment};
use crate::codec::arith::{ArithCx, ArithDecoder, ArithIaidDecoder, ArithIntDecoder};

/// The reference corner of a symbol (JBig2Corner).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Corner {
    BottomLeft,
    TopLeft,
    BottomRight,
    TopRight,
}

impl Corner {
    pub fn from_bits(bits: u16) -> Corner {
        match bits & 3 {
            0 => Corner::BottomLeft,
            1 => Corner::TopLeft,
            2 => Corner::BottomRight,
            _ => Corner::TopRight,
        }
    }
}

/// The integer decoders of arithmetic text decoding, which symbol dictionaries share across the symbols they decode
/// by aggregation.
pub struct IntStates {
    pub iadt: ArithIntDecoder,
    pub iafs: ArithIntDecoder,
    pub iads: ArithIntDecoder,
    pub iait: ArithIntDecoder,
    pub iari: ArithIntDecoder,
    pub iardw: ArithIntDecoder,
    pub iardh: ArithIntDecoder,
    pub iardx: ArithIntDecoder,
    pub iardy: ArithIntDecoder,
    pub iaid: ArithIaidDecoder,
}

impl IntStates {
    pub fn new(symbol_code_len: u32) -> Self {
        IntStates {
            iadt: ArithIntDecoder::new(),
            iafs: ArithIntDecoder::new(),
            iads: ArithIntDecoder::new(),
            iait: ArithIntDecoder::new(),
            iari: ArithIntDecoder::new(),
            iardw: ArithIntDecoder::new(),
            iardh: ArithIntDecoder::new(),
            iardx: ArithIntDecoder::new(),
            iardy: ArithIntDecoder::new(),
            iaid: ArithIaidDecoder::new(symbol_code_len),
        }
    }
}

/// The tables of a Huffman coded text region.
pub struct TextTables {
    pub fs: HuffmanTable,
    pub ds: HuffmanTable,
    pub dt: HuffmanTable,
    pub rdw: HuffmanTable,
    pub rdh: HuffmanTable,
    pub rdx: HuffmanTable,
    pub rdy: HuffmanTable,
    pub rsize: HuffmanTable,
}

/// A text region's parameters.
pub struct TextRegion<'a> {
    pub width: i32,
    pub height: i32,
    pub refine: bool,
    pub num_instances: u32,
    /// SBSTRIPS: 1, 2, 4 or 8.
    pub strips: i32,
    /// SBSYMS.
    pub symbols: &'a [&'a Symbol],
    /// SBSYMCODES: the prefix codes of the symbols (Huffman coding).
    pub symbol_codes: Vec<Code>,
    pub def_pixel: bool,
    pub comb_op: ComposeOp,
    pub transposed: bool,
    pub ref_corner: Corner,
    pub ds_offset: i32,
    /// Present for Huffman coding.
    pub tables: Option<TextTables>,
    pub r_template: u8,
    pub r_at: [i8; 4],
}

/// The part of a region the refinement of a symbol (T.88 6.4.11) gives: its bitmap, or none at all.
fn refined_symbol(
    original: &Symbol,
    r_template: u8,
    r_at: [i8; 4],
    deltas: [i32; 4],
    decoder: &mut ArithDecoder,
    cx: &mut [ArithCx],
) -> Result<Option<Symbol>, Failure> {
    let blank;
    let reference = match original {
        Symbol::Null => return Err(Failure),
        // nothing to read: every pixel of the reference is white
        Symbol::Empty => {
            blank = Image::new(1, 1).ok_or(Failure)?;
            &blank
        }
        Symbol::Bitmap(image) => image,
    };
    let [rdw, rdh, rdx, rdy] = deltas;
    let width = original.width().wrapping_add(rdw);
    let height = original.height().wrapping_add(rdh);
    if !Image::is_valid_region_size(width, height) {
        // the decoder creates an image of that size without decoding into it: one with no pixels (no size, or one it
        // cannot allocate) is an empty image
        return Ok(Some(Image::new(width, height).map_or(Symbol::Empty, Symbol::Bitmap)));
    }
    let region = RefinementRegion {
        width,
        height,
        template: r_template,
        tpgron: false,
        reference,
        // T.88 6.4.11: the reference moves by half the change of size, rounded down, plus the offset coded.
        dx: (rdw >> 1).wrapping_add(rdx),
        dy: (rdh >> 1).wrapping_add(rdy),
        at: r_at,
    };
    Ok(region.decode(decoder, cx).map(Symbol::Bitmap))
}

impl TextRegion<'_> {
    fn corner_offset_s(&self, width: i32, height: i32) -> i32 {
        match (self.transposed, self.ref_corner) {
            (false, Corner::TopRight | Corner::BottomRight) => width.wrapping_sub(1),
            (true, Corner::BottomLeft | Corner::BottomRight) => height.wrapping_sub(1),
            _ => 0,
        }
    }

    fn corner_advance_s(&self, width: i32, height: i32) -> i32 {
        match (self.transposed, self.ref_corner) {
            (false, Corner::TopLeft | Corner::BottomLeft) => width.wrapping_sub(1),
            (true, Corner::TopLeft | Corner::TopRight) => height.wrapping_sub(1),
            _ => 0,
        }
    }

    /// Composes a symbol of `width` x `height` at (`s`, `t`) onto `region` for the reference corner.
    fn place(&self, region: &mut Image, image: Option<&Image>, width: i32, height: i32, s: i32, t: i32) {
        let Some(image) = image else {
            return;
        };
        let (x, y) = if self.transposed { (t, s) } else { (s, t) };
        let (x, y) = match self.ref_corner {
            Corner::TopLeft => (x, y),
            Corner::TopRight => (x.wrapping_sub(width.wrapping_sub(1)), y),
            Corner::BottomLeft => (x, y.wrapping_sub(height.wrapping_sub(1))),
            Corner::BottomRight => (
                x.wrapping_sub(width.wrapping_sub(1)),
                y.wrapping_sub(height.wrapping_sub(1)),
            ),
        };
        image.compose_to(region, x, y, self.comb_op);
    }

    /// `DecodeArith`: the region as arithmetic coded, with the context table `gr_cx` of the refinements and the
    /// integer decoders `ids`. The strip and symbol positions are added with overflow checks (an overflow fails the
    /// region); a refinement that fails to decode leaves the instance out.
    pub fn decode_arith(
        &self,
        decoder: &mut ArithDecoder,
        gr_cx: &mut [ArithCx],
        ids: &mut IntStates,
    ) -> Option<Image> {
        let mut region = Image::new(self.width, self.height)?;
        region.fill(self.def_pixel);
        let initial = ids.iadt.decode(decoder)?;
        let mut strip_t = initial.checked_mul(self.strips)?.checked_neg()?;
        let mut first_s = 0i32;
        let mut instances = 0u32;
        while instances < self.num_instances {
            let dt = ids.iadt.decode(decoder)?;
            strip_t = strip_t.checked_add(dt.wrapping_mul(self.strips))?;
            let mut first = true;
            let mut cur_s = 0i32;
            loop {
                if first {
                    let dfs = ids.iafs.decode(decoder).unwrap_or(0);
                    first_s = first_s.checked_add(dfs)?;
                    cur_s = first_s;
                    first = false;
                } else {
                    let Some(ids_value) = ids.iads.decode(decoder) else {
                        break;
                    };
                    cur_s = cur_s.checked_add(ids_value)?.checked_add(self.ds_offset)?;
                }
                if instances >= self.num_instances {
                    break;
                }
                let cur_t = if self.strips != 1 {
                    ids.iait.decode(decoder).unwrap_or(0)
                } else {
                    0
                };
                let t = strip_t.checked_add(cur_t)?;
                let id = ids.iaid.decode(decoder);
                let original = *self.symbols.get(id as usize)?;
                let refined = if self.refine {
                    ids.iari.decode(decoder).unwrap_or(0)
                } else {
                    0
                };
                let owned;
                let symbol: &Symbol = if refined == 0 {
                    original
                } else {
                    let deltas = [
                        ids.iardw.decode(decoder).unwrap_or(0),
                        ids.iardh.decode(decoder).unwrap_or(0),
                        ids.iardx.decode(decoder).unwrap_or(0),
                        ids.iardy.decode(decoder).unwrap_or(0),
                    ];
                    owned = match refined_symbol(
                        original,
                        self.r_template,
                        self.r_at,
                        deltas,
                        decoder,
                        gr_cx,
                    ) {
                        Ok(Some(symbol)) => symbol,
                        Ok(None) => continue,
                        Err(Failure) => return None,
                    };
                    &owned
                };
                match symbol {
                    Symbol::Null => continue,
                    // composing an image that has no pixels fails the region
                    Symbol::Empty => return None,
                    Symbol::Bitmap(_) => {}
                }
                let (width, height) = (symbol.width(), symbol.height());
                cur_s = cur_s.wrapping_add(self.corner_offset_s(width, height));
                self.place(&mut region, symbol.image(), width, height, cur_s, t);
                cur_s = cur_s.wrapping_add(self.corner_advance_s(width, height));
                instances += 1;
            }
        }
        Some(region)
    }

    /// `DecodeHuffman`: the region as Huffman coded from `stream`. A strip ends only at its out-of-band value: unlike
    /// the arithmetic decoder this one decodes instances beyond `num_instances` when a strip goes on.
    pub fn decode_huffman(&self, stream: &mut BitStream, gr_cx: &mut [ArithCx]) -> Option<Image> {
        let tables = self.tables.as_ref()?;
        let mut region = Image::new(self.width, self.height)?;
        region.fill(self.def_pixel);
        let initial = tables.dt.decode(stream)?.value()?;
        let mut strip_t = initial.checked_mul(self.strips)?.checked_neg()?;
        let mut first_s = 0i32;
        let mut instances = 0u32;
        while instances < self.num_instances {
            let dt = tables.dt.decode(stream)?.value()?;
            strip_t = strip_t.checked_add(dt.wrapping_mul(self.strips))?;
            let mut first = true;
            let mut cur_s = 0i32;
            loop {
                if first {
                    let dfs = tables.fs.decode(stream)?.value()?;
                    first_s = first_s.checked_add(dfs)?;
                    cur_s = first_s;
                    first = false;
                } else {
                    let Some(ids_value) = tables.ds.decode(stream)?.value() else {
                        break;
                    };
                    cur_s = cur_s.checked_add(ids_value)?.checked_add(self.ds_offset)?;
                }
                let cur_t = if self.strips != 1 {
                    stream.read_nbits(self.strips.trailing_zeros())? as i32
                } else {
                    0
                };
                let t = strip_t.checked_add(cur_t)?;
                let id = self.read_symbol_id(stream)?;
                let original = self.symbols[id];
                let refined = if self.refine { stream.read_1bit()? } else { 0 };
                let owned;
                let symbol: &Symbol = if refined == 0 {
                    original
                } else {
                    let rdw = tables.rdw.decode(stream)?.value()?;
                    let rdh = tables.rdh.decode(stream)?.value()?;
                    let rdx = tables.rdx.decode(stream)?.value()?;
                    let rdy = tables.rdy.decode(stream)?.value()?;
                    let size = tables.rsize.decode(stream)?.value()?;
                    stream.align_byte();
                    let start = stream.byte_index();
                    let mut decoder = ArithDecoder::new(stream.data(), start);
                    let refined = refined_symbol(
                        original,
                        self.r_template,
                        self.r_at,
                        [rdw, rdh, rdx, rdy],
                        &mut decoder,
                        gr_cx,
                    )
                    .ok()?;
                    owned = refined?;
                    stream.set_byte_index(decoder.byte_index());
                    stream.align_byte();
                    stream.add_offset(2);
                    if size as u32 != stream.byte_index().wrapping_sub(start) {
                        return None;
                    }
                    &owned
                };
                match symbol {
                    Symbol::Null => continue,
                    // composing an image that has no pixels fails the region
                    Symbol::Empty => return None,
                    Symbol::Bitmap(_) => {}
                }
                let (width, height) = (symbol.width(), symbol.height());
                cur_s = cur_s.wrapping_add(self.corner_offset_s(width, height));
                self.place(&mut region, symbol.image(), width, height, cur_s, t);
                cur_s = cur_s.wrapping_add(self.corner_advance_s(width, height));
                instances += 1;
            }
        }
        Some(region)
    }

    /// The symbol whose prefix code comes next in `stream`. `None` when the data ends before one does.
    fn read_symbol_id(&self, stream: &mut BitStream) -> Option<usize> {
        let longest = self.symbol_codes.iter().map(|c| c.len).max().unwrap_or(0);
        let mut value = 0u32;
        let mut bits = 0u32;
        while bits < longest {
            value = (value << 1) | stream.read_1bit()?;
            bits += 1;
            if let Some(id) = self.symbol_codes.iter().position(|c| c.len == bits && c.code == value) {
                return Some(id);
            }
        }
        None
    }
}

/// `DecodeSymbolIDHuffmanTable`: the prefix codes of `count` symbols, coded in the segment as run-length coded prefix
/// lengths (T.88 7.4.3.1.7). `None` when the data is malformed or `count` is 0.
fn read_symbol_codes(stream: &mut BitStream, count: u32) -> Option<Vec<Code>> {
    let mut run_codes = Vec::with_capacity(35);
    for _ in 0..35 {
        run_codes.push(Code {
            len: stream.read_nbits(4)?,
            code: 0,
        });
    }
    let run_codes = assigned(run_codes)?;
    let mut codes = vec![Code::default(); count as usize];
    let mut i = 0usize;
    while i < codes.len() {
        let run_code = {
            let mut value = 0u32;
            let mut bits = 0u32;
            loop {
                if bits >= 15 {
                    return None;
                }
                value = (value << 1) | stream.read_1bit()?;
                bits += 1;
                if let Some(j) = run_codes.iter().position(|c| c.len == bits && c.code == value) {
                    break j;
                }
            }
        };
        let run = match run_code {
            0..=31 => {
                codes[i].len = run_code as u32;
                0
            }
            32 => stream.read_nbits(2)? as usize + 3,
            33 => stream.read_nbits(3)? as usize + 3,
            _ => stream.read_nbits(7)? as usize + 11,
        };
        if run > 0 {
            if i + run > codes.len() {
                return None;
            }
            for k in 0..run {
                codes[i + k].len = if run_code == 32 && i > 0 { codes[i - 1].len } else { 0 };
            }
            i += run;
        } else {
            i += 1;
        }
    }
    let codes = assigned(codes)?;
    (!codes.is_empty()).then_some(codes)
}

/// The most symbol ids of 0.25 bits a stream of `length` bytes can hold: `SBNUMINSTANCES / 4` may not exceed it.
fn too_many_instances(instances: u32, length: usize) -> bool {
    (instances / 4) as usize > length
}

/// The number of bits of a symbol id for `count` symbols (`SBSYMCODELEN`).
pub fn symbol_code_length(count: u32) -> u32 {
    let mut len = 0;
    while (1u64 << len) < u64::from(count) {
        len += 1;
    }
    len
}

impl Context<'_> {
    /// `ParseTextRegion` (T.88 7.4.3): types 4 (intermediate), 6 and 7 (immediate).
    pub(super) fn parse_text_region(
        &mut self,
        segment: &mut Segment,
        globals: Option<&Context<'_>>,
        page: Option<&mut super::page::Page>,
    ) -> Result<Flow, Failure> {
        let info = self.read_region_info()?;
        let flags = self.stream.read_u16().ok_or(Failure)?;
        if !Image::is_valid_region_size(info.width, info.height) {
            return Err(Failure);
        }
        let huffman = flags & 1 != 0;
        let refine = (flags >> 1) & 1 != 0;
        let strips = 1i32 << ((flags >> 2) & 3);
        let ref_corner = Corner::from_bits(flags >> 4);
        let transposed = (flags >> 6) & 1 != 0;
        let comb_op = ComposeOp::from_flags(((flags >> 7) & 3) as u8);
        let def_pixel = (flags >> 9) & 1 != 0;
        let mut ds_offset = i32::from((flags >> 10) & 0x1f);
        if ds_offset >= 0x10 {
            ds_offset -= 0x20;
        }
        let r_template = u8::from((flags >> 15) & 1 != 0);
        let mut table_flags = 0u16;
        if huffman {
            table_flags = self.stream.read_u16().ok_or(Failure)?;
        }
        let mut r_at = [0i8; 4];
        if refine && r_template == 0 {
            for slot in &mut r_at {
                *slot = self.stream.read_u8().ok_or(Failure)? as i8;
            }
        }
        let num_instances = self.stream.read_u32().ok_or(Failure)?;
        if too_many_instances(num_instances, self.stream.data().len()) {
            return Err(Failure);
        }
        let Context { stream, segments, .. } = self;
        let mut found = Vec::with_capacity(segment.referred.len());
        for &number in &segment.referred {
            found.push(find_segment(globals, segments, number).ok_or(Failure)?);
        }
        let mut symbols: Vec<&Symbol> = Vec::new();
        for referred in &found {
            if let (0, SegmentResult::Symbols(dict)) = (referred.kind, &referred.result) {
                symbols.extend(dict.symbols.iter());
            }
        }
        let count = u32::try_from(symbols.len()).map_err(|_| Failure)?;
        let mut symbol_codes = Vec::new();
        if huffman {
            symbol_codes = read_symbol_codes(stream, count).ok_or(Failure)?;
            stream.align_byte();
        }
        let tables = if huffman {
            Some(text_tables(table_flags, &found)?)
        } else {
            None
        };
        let region = TextRegion {
            width: info.width,
            height: info.height,
            refine,
            num_instances,
            strips,
            symbols: &symbols,
            symbol_codes,
            def_pixel,
            comb_op,
            transposed,
            ref_corner,
            ds_offset,
            tables,
            r_template,
            r_at,
        };
        let mut gr_cx = if refine {
            vec![ArithCx::default(); refine::context_count(r_template)]
        } else {
            Vec::new()
        };
        let image = if huffman {
            let image = region.decode_huffman(stream, &mut gr_cx).ok_or(Failure)?;
            stream.align_byte();
            image
        } else {
            let mut ids = IntStates::new(symbol_code_length(count));
            let mut decoder = ArithDecoder::new(stream.data(), stream.byte_index());
            let image = region.decode_arith(&mut decoder, &mut gr_cx, &mut ids).ok_or(Failure)?;
            stream.set_byte_index(decoder.byte_index());
            stream.align_byte();
            stream.add_offset(2);
            image
        };
        Self::finish_region(segment, image, &info, page, 4);
        Ok(Flow::Continue)
    }
}

/// The tables the flags of a Huffman coded text region choose: standard ones, or the table segments the segment refers
/// to, in the order the choices ask for them.
fn text_tables(flags: u16, referred: &[&Segment]) -> Result<TextTables, Failure> {
    let choice = |shift: u16, width: u16| (flags >> shift) & ((1 << width) - 1);
    let (fs, ds, dt) = (choice(0, 2), choice(2, 2), choice(4, 2));
    let (rdw, rdh, rdx, rdy, rsize) = (choice(6, 2), choice(8, 2), choice(10, 2), choice(12, 2), choice(14, 1));
    if [fs, rdw, rdh, rdx, rdy].contains(&2) {
        return Err(Failure);
    }
    let mut next = 0;
    let mut pick = |choice: u16, standard: &[usize]| -> Result<HuffmanTable, Failure> {
        if let Some(&index) = standard.get(usize::from(choice)) {
            return Ok(HuffmanTable::standard(index));
        }
        let table = super::symbols::referred_table(referred, next).ok_or(Failure)?;
        next += 1;
        Ok(table)
    };
    Ok(TextTables {
        fs: pick(fs, &[6, 7])?,
        ds: pick(ds, &[8, 9, 10])?,
        dt: pick(dt, &[11, 12, 13])?,
        rdw: pick(rdw, &[14, 15])?,
        rdh: pick(rdh, &[14, 15])?,
        rdx: pick(rdx, &[14, 15])?,
        rdy: pick(rdy, &[14, 15])?,
        rsize: pick(rsize, &[1])?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn symbol_code_lengths() {
        assert_eq!(symbol_code_length(0), 0);
        assert_eq!(symbol_code_length(1), 0);
        assert_eq!(symbol_code_length(2), 1);
        assert_eq!(symbol_code_length(3), 2);
        assert_eq!(symbol_code_length(4), 2);
        assert_eq!(symbol_code_length(5), 3);
        assert_eq!(symbol_code_length(65536), 16);
    }

    #[test]
    fn corners() {
        assert_eq!(Corner::from_bits(0), Corner::BottomLeft);
        assert_eq!(Corner::from_bits(1), Corner::TopLeft);
        assert_eq!(Corner::from_bits(2), Corner::BottomRight);
        assert_eq!(Corner::from_bits(3), Corner::TopRight);
    }

    fn glyph(rows: &[&str]) -> Symbol {
        let mut img = Image::new(rows[0].len() as i32, rows.len() as i32).unwrap();
        for (y, row) in rows.iter().enumerate() {
            for (x, ch) in row.chars().enumerate() {
                img.set_pixel(x as i32, y as i32, u8::from(ch == '#'));
            }
        }
        Symbol::Bitmap(img)
    }

    fn render(img: &Image) -> Vec<String> {
        (0..img.height())
            .map(|y| {
                (0..img.width())
                    .map(|x| if img.get_pixel(x, y) == 1 { '#' } else { '.' })
                    .collect()
            })
            .collect()
    }

    fn region<'a>(symbols: &'a [&'a Symbol], transposed: bool, corner: Corner) -> TextRegion<'a> {
        TextRegion {
            width: 6,
            height: 6,
            refine: false,
            num_instances: 0,
            strips: 1,
            symbols,
            symbol_codes: Vec::new(),
            def_pixel: false,
            comb_op: ComposeOp::Or,
            transposed,
            ref_corner: corner,
            ds_offset: 0,
            tables: None,
            r_template: 0,
            r_at: [0; 4],
        }
    }

    /// The reference corner puts the symbol's corner at the given position, transposed or not.
    #[test]
    fn symbols_are_placed_by_their_reference_corner() {
        let glyph = glyph(&["##", "#."]);
        let symbols = [&glyph];
        let mut img = Image::new(6, 6).unwrap();
        let top_left = region(&symbols, false, Corner::TopLeft);
        top_left.place(&mut img, glyph.image(), 2, 2, 1, 1);
        assert_eq!(render(&img)[1..3], [".##...", ".#...."]);
        let mut img = Image::new(6, 6).unwrap();
        let bottom_right = region(&symbols, false, Corner::BottomRight);
        bottom_right.place(&mut img, glyph.image(), 2, 2, 4, 4);
        assert_eq!(render(&img)[3..5], ["...##.", "...#.."]);
        // transposed: s runs down, t across
        let mut img = Image::new(6, 6).unwrap();
        let transposed = region(&symbols, true, Corner::TopLeft);
        transposed.place(&mut img, glyph.image(), 2, 2, 3, 1);
        assert_eq!(render(&img)[3..5], [".##...", ".#...."]);
        assert_eq!(top_left.corner_offset_s(2, 3), 0);
        assert_eq!(bottom_right.corner_offset_s(2, 3), 1);
        assert_eq!(top_left.corner_advance_s(2, 3), 1);
        assert_eq!(transposed.corner_advance_s(2, 3), 2);
    }

    #[test]
    fn symbol_id_codes_are_read_as_runs() {
        // 35 run codes of 4 bits: code 1 has length 1, code 32 (repeat) length 2, others unused... build lengths
        let mut lens = [0u32; 35];
        lens[1] = 1; // runcode 1 -> prefix "0"
        lens[2] = 2; // runcode 2 -> prefix "10"
        lens[32] = 2; // runcode 32 -> prefix "11"
        let mut bits: Vec<bool> = Vec::new();
        for l in lens {
            for i in (0..4).rev() {
                bits.push((l >> i) & 1 == 1);
            }
        }
        // symbols: 1, 2, repeat previous 3 times (extra bits 00 = 3)
        for b in [false, true, false, true, true, false, false] {
            bits.push(b);
        }
        let mut bytes = vec![0u8; bits.len().div_ceil(8)];
        for (i, b) in bits.iter().enumerate() {
            if *b {
                bytes[i / 8] |= 0x80 >> (i % 8);
            }
        }
        let mut stream = BitStream::new(&bytes);
        let codes = read_symbol_codes(&mut stream, 5).unwrap();
        assert_eq!(codes.iter().map(|c| c.len).collect::<Vec<_>>(), [1, 2, 2, 2, 2]);
        assert_eq!(codes[0].code, 0);
        assert_eq!(codes[1].code, 2);
        assert_eq!(codes[2].code, 3);
        assert!(read_symbol_codes(&mut BitStream::new(&bytes), 0).is_none());
    }

    #[test]
    fn instance_counts_are_bounded_by_the_data() {
        assert!(!too_many_instances(40, 10));
        assert!(too_many_instances(44, 10));
    }
}
