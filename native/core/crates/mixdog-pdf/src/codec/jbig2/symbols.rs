//! Symbol dictionaries (T.88 6.5, PDFium's `CJBig2_SDDProc`) in both coding modes with refinement and aggregation, the
//! symbol dictionary segment (type 0, with retained bitmap contexts) and the custom Huffman table segment (type 53).

use super::generic::{self, GenericRegion};
use super::huffman::HuffmanTable;
use super::image::Image;
use super::refine::{self, RefinementRegion};
use super::text::{Corner, IntStates, TextRegion, TextTables, symbol_code_length};
use super::{BitStream, Context, Failure, Flow, Segment, SegmentResult, find_segment};
use crate::codec::arith::{ArithCx, ArithDecoder, ArithIntDecoder};

/// The most symbols a dictionary exports or defines (`JBIG2_MAX_EXPORT_SYSMBOLS`, `JBIG2_MAX_NEW_SYSMBOLS`).
const MAX_SYMBOLS: u32 = 1 << 20;
/// The tallest and widest symbol (`JBIG2_MAX_IMAGE_SIZE`).
const MAX_SYMBOL_SIZE: i32 = 65535;

/// A symbol of a dictionary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Symbol {
    /// No bitmap (a symbol with no pixels to code).
    Null,
    /// A bitmap of no size: the decoder made an image it could not allocate.
    Empty,
    Bitmap(Image),
}

impl Symbol {
    pub fn width(&self) -> i32 {
        self.image().map_or(0, Image::width)
    }

    pub fn height(&self) -> i32 {
        self.image().map_or(0, Image::height)
    }

    pub fn image(&self) -> Option<&Image> {
        match self {
            Symbol::Bitmap(image) => Some(image),
            _ => None,
        }
    }
}

/// A symbol dictionary segment's result: the exported symbols and the bitmap coding contexts a later dictionary may
/// continue with.
pub struct SymbolDict {
    pub symbols: Vec<Symbol>,
    pub gb_contexts: Vec<ArithCx>,
    pub gr_contexts: Vec<ArithCx>,
}

/// The `index`th table segment (type 53) among the segments a segment refers to.
pub(super) fn referred_table(referred: &[&Segment], index: usize) -> Option<HuffmanTable> {
    referred.iter().filter(|s| s.kind == 53).nth(index).and_then(|s| match &s.result {
        SegmentResult::Table(table) => Some(table.clone()),
        _ => None,
    })
}

/// The tables of a Huffman coded symbol dictionary.
struct SymbolTables {
    dh: HuffmanTable,
    dw: HuffmanTable,
    bm_size: HuffmanTable,
    agg_inst: HuffmanTable,
}

/// A symbol dictionary's parameters.
struct SymbolDecoder<'a> {
    refagg: bool,
    template: u8,
    r_template: u8,
    at: [i8; 8],
    r_at: [i8; 4],
    num_ex: u32,
    num_new: u32,
    /// SDINSYMS.
    in_symbols: &'a [&'a Symbol],
}

fn valid_symbol_size(value: u32) -> bool {
    let value = value as i32;
    (0..=MAX_SYMBOL_SIZE).contains(&value)
}

/// The sub-image of the collective bitmap of a height class holding a symbol.
fn cut(collective: Option<&Image>, x: i32, width: i32, height: i32) -> Symbol {
    let cut = match collective {
        Some(image) => image.sub_image(x, 0, width, height),
        None => Image::new(width, height),
    };
    cut.map_or(Symbol::Empty, Symbol::Bitmap)
}

impl SymbolDecoder<'_> {
    fn total(&self) -> u32 {
        self.in_symbols.len() as u32 + self.num_new
    }

    /// The symbols the symbols decoded by aggregation may refer to: the input symbols and the new ones so far.
    fn known<'s>(&'s self, new: &'s [Symbol], count: usize) -> Vec<&'s Symbol> {
        self.in_symbols.iter().copied().chain(new[..count].iter()).collect()
    }

    /// The export flags (T.88 6.5.10) turned into the exported symbols: the input symbols and the new ones the
    /// flags choose, at most `num_ex`.
    fn export(&self, new: Vec<Symbol>, flags: &[bool]) -> Option<Vec<Symbol>> {
        let exported = flags.iter().filter(|&&f| f).count() as u32;
        if exported > self.num_ex {
            return None;
        }
        let mut new = new;
        let mut symbols = Vec::with_capacity(exported as usize);
        for (i, _) in flags.iter().enumerate().filter(|(_, f)| **f) {
            symbols.push(match self.in_symbols.get(i) {
                Some(symbol) => (*symbol).clone(),
                None => std::mem::replace(&mut new[i - self.in_symbols.len()], Symbol::Null),
            });
        }
        Some(symbols)
    }

    /// `DecodeArith`.
    fn decode_arith(&self, decoder: &mut ArithDecoder, gb: &mut [ArithCx], gr: &mut [ArithCx]) -> Option<Vec<Symbol>> {
        let mut iadh = ArithIntDecoder::new();
        let mut iadw = ArithIntDecoder::new();
        let mut iaai = ArithIntDecoder::new();
        let mut iaex = ArithIntDecoder::new();
        let total = self.total();
        let mut ids = IntStates::new(symbol_code_length(total));
        let mut new = vec![Symbol::Null; self.num_new as usize];
        let mut height_class = 0u32;
        let mut decoded = 0u32;
        while decoded < self.num_new {
            height_class = height_class.wrapping_add(iadh.decode(decoder).unwrap_or(0) as u32);
            if !valid_symbol_size(height_class) {
                return None;
            }
            let mut width = 0u32;
            loop {
                let Some(delta) = iadw.decode(decoder) else {
                    break;
                };
                if decoded >= self.num_new {
                    return None;
                }
                width = width.wrapping_add(delta as u32);
                if !valid_symbol_size(width) {
                    return None;
                }
                if height_class == 0 || width == 0 {
                    decoded += 1;
                    continue;
                }
                let (w, h) = (width as i32, height_class as i32);
                new[decoded as usize] = if !self.refagg {
                    let region = GenericRegion { width: w, height: h, template: self.template, tpgdon: false, skip: None, at: self.at };
                    let image = region.decode_arith(decoder, gb)?;
                    if image.rows < h {
                        return None;
                    }
                    Symbol::Bitmap(image.image)
                } else {
                    let instances = iaai.decode(decoder).unwrap_or(0);
                    if instances > 1 {
                        let known = self.known(&new, decoded as usize);
                        let region = TextRegion {
                            width: w,
                            height: h,
                            refine: true,
                            num_instances: instances as u32,
                            strips: 1,
                            symbols: &known,
                            symbol_codes: Vec::new(),
                            def_pixel: false,
                            comb_op: super::image::ComposeOp::Or,
                            transposed: false,
                            ref_corner: Corner::TopLeft,
                            ds_offset: 0,
                            tables: None,
                            r_template: self.r_template,
                            r_at: self.r_at,
                        };
                        Symbol::Bitmap(region.decode_arith(decoder, gr, &mut ids)?)
                    } else if instances == 1 {
                        let id = ids.iaid.decode(decoder);
                        let dx = ids.iardx.decode(decoder).unwrap_or(0);
                        let dy = ids.iardy.decode(decoder).unwrap_or(0);
                        if id >= total {
                            return None;
                        }
                        let known = self.known(&new, self.num_new as usize);
                        let blank;
                        let reference = match known[id as usize] {
                            Symbol::Null => return None,
                            Symbol::Empty => {
                                blank = Image::new(1, 1)?;
                                &blank
                            }
                            Symbol::Bitmap(image) => image,
                        };
                        let region = RefinementRegion { width: w, height: h, template: self.r_template, tpgron: false, reference, dx, dy, at: self.r_at };
                        Symbol::Bitmap(region.decode(decoder, gr)?)
                    } else {
                        Symbol::Null
                    }
                };
                decoded += 1;
            }
        }
        let mut flags = vec![false; total as usize];
        let mut current = false;
        let mut index = 0u32;
        let mut steps = 0u64;
        while index < total {
            steps += 1;
            if steps > 2 * u64::from(total) + 2 {
                return None;
            }
            let run = iaex.decode(decoder).unwrap_or(0) as u32;
            let end = index.checked_add(run)?;
            if end > total {
                return None;
            }
            flags[index as usize..end as usize].fill(current);
            index = end;
            current = !current;
        }
        self.export(new, &flags)
    }

    /// `DecodeHuffman`.
    fn decode_huffman(&self, stream: &mut BitStream, tables: &SymbolTables, gr: &mut [ArithCx]) -> Option<Vec<Symbol>> {
        let total = self.total();
        let mut new = vec![Symbol::Null; self.num_new as usize];
        let mut widths = vec![0u32; self.num_new as usize];
        let mut height_class = 0u32;
        let mut decoded = 0u32;
        while decoded < self.num_new {
            height_class = height_class.wrapping_add(tables.dh.decode(stream)?.value()? as u32);
            if !valid_symbol_size(height_class) {
                return None;
            }
            let mut width = 0u32;
            let mut total_width = 0u32;
            let first = decoded;
            loop {
                let Some(delta) = tables.dw.decode(stream)?.value() else {
                    break;
                };
                if decoded >= self.num_new {
                    return None;
                }
                width = width.wrapping_add(delta as u32);
                if !valid_symbol_size(width) {
                    return None;
                }
                total_width = total_width.wrapping_add(width);
                if height_class == 0 || width == 0 {
                    decoded += 1;
                    continue;
                }
                let (w, h) = (width as i32, height_class as i32);
                if self.refagg {
                    let instances = tables.agg_inst.decode(stream)?.value()?;
                    let symbol = if instances > 1 {
                        let known = self.known(&new, decoded as usize);
                        let count = known.len() as u32;
                        // the codes of the symbols so far have the length the whole dictionary's symbol count needs
                        let mut code_len = 1u32;
                        while (1u64 << code_len) < u64::from(total) {
                            code_len += 1;
                        }
                        let region = TextRegion {
                            width: w,
                            height: h,
                            refine: true,
                            num_instances: instances as u32,
                            strips: 1,
                            symbols: &known,
                            symbol_codes: (0..count).map(|code| super::huffman::Code { len: code_len, code }).collect(),
                            def_pixel: false,
                            comb_op: super::image::ComposeOp::Or,
                            transposed: false,
                            ref_corner: Corner::TopLeft,
                            ds_offset: 0,
                            tables: Some(TextTables {
                                fs: HuffmanTable::standard(6),
                                ds: HuffmanTable::standard(8),
                                dt: HuffmanTable::standard(11),
                                rdw: HuffmanTable::standard(15),
                                rdh: HuffmanTable::standard(15),
                                rdx: HuffmanTable::standard(15),
                                rdy: HuffmanTable::standard(15),
                                rsize: HuffmanTable::standard(1),
                            }),
                            r_template: self.r_template,
                            r_at: self.r_at,
                        };
                        Symbol::Bitmap(region.decode_huffman(stream, gr)?)
                    } else if instances == 1 {
                        let mut code_len = 1u32;
                        while (1u64 << code_len) < u64::from(total) {
                            code_len += 1;
                        }
                        let mut id = 0u32;
                        for _ in 0..code_len {
                            id = (id << 1) | stream.read_1bit()?;
                        }
                        let dx = HuffmanTable::standard(15).decode(stream)?.value()?;
                        let dy = HuffmanTable::standard(15).decode(stream)?.value()?;
                        let size = HuffmanTable::standard(1).decode(stream)?.value()?;
                        stream.align_byte();
                        let start = stream.byte_index();
                        if id >= total {
                            return None;
                        }
                        let known = self.known(&new, self.num_new as usize);
                        let blank;
                        let reference = match known[id as usize] {
                            Symbol::Null => return None,
                            Symbol::Empty => {
                                blank = Image::new(1, 1)?;
                                &blank
                            }
                            Symbol::Bitmap(image) => image,
                        };
                        let region = RefinementRegion { width: w, height: h, template: self.r_template, tpgron: false, reference, dx, dy, at: self.r_at };
                        let mut decoder = ArithDecoder::new(stream.data(), start);
                        let image = region.decode(&mut decoder, gr)?;
                        stream.set_byte_index(decoder.byte_index());
                        stream.align_byte();
                        stream.add_offset(2);
                        if size as u32 != stream.byte_index().wrapping_sub(start) {
                            return None;
                        }
                        Symbol::Bitmap(image)
                    } else {
                        Symbol::Null
                    };
                    new[decoded as usize] = symbol;
                } else {
                    widths[decoded as usize] = width;
                }
                decoded += 1;
            }
            if !self.refagg {
                let size = tables.bm_size.decode(stream)?.value()? as u32;
                stream.align_byte();
                let (w, h) = (total_width as i32, height_class as i32);
                let collective = if size == 0 {
                    let stride = (u64::from(total_width) + 7) / 8;
                    let bytes = stride * u64::from(height_class);
                    if u64::from(stream.byte_left()) < bytes {
                        return None;
                    }
                    let mut image = Image::new(w, h);
                    let start = stream.byte_index() as usize;
                    if let Some(image) = image.as_mut() {
                        let pitch = image.stride();
                        for row in 0..height_class as usize {
                            let from = start + row * stride as usize;
                            image.data_mut()[row * pitch..row * pitch + stride as usize].copy_from_slice(&stream.data()[from..from + stride as usize]);
                        }
                    }
                    stream.add_offset(bytes as u32);
                    Some(image)
                } else {
                    let region = GenericRegion { width: w, height: h, template: 0, tpgdon: false, skip: None, at: [0; 8] };
                    let image = region.decode_mmr(stream.data(), stream.bit_position());
                    let collective = image.map(|(image, bits)| {
                        stream.set_bit_position(bits);
                        image
                    });
                    stream.align_byte();
                    collective.map(Some)
                };
                let Some(collective) = collective else {
                    continue;
                };
                let mut x = 0i32;
                for i in first..decoded {
                    let symbol_width = widths[i as usize];
                    new[i as usize] = cut(collective.as_ref(), x, symbol_width as i32, h);
                    x = x.wrapping_add(symbol_width as i32);
                }
            }
        }
        let table = HuffmanTable::standard(1);
        let mut flags = vec![false; total as usize];
        let mut current = false;
        let mut index = 0u32;
        let mut steps = 0u64;
        while index < total {
            steps += 1;
            if steps > 2 * u64::from(total) + 2 {
                return None;
            }
            let run = table.decode(stream)?.value()? as u32;
            let end = index.checked_add(run)?;
            if end > total {
                return None;
            }
            flags[index as usize..end as usize].fill(current);
            index = end;
            current = !current;
        }
        self.export(new, &flags)
    }
}

impl Context<'_> {
    /// `ParseSymbolDict` (T.88 7.4.2).
    pub(super) fn parse_symbol_dict(&mut self, segment: &mut Segment, globals: Option<&Context<'_>>) -> Result<Flow, Failure> {
        let flags = self.stream.read_u16().ok_or(Failure)?;
        let huffman = flags & 1 != 0;
        let refagg = (flags >> 1) & 1 != 0;
        let template = ((flags >> 10) & 3) as u8;
        let r_template = ((flags >> 12) & 1) as u8;
        let mut at = [0i8; 8];
        if !huffman {
            let pairs = if template == 0 { 8 } else { 2 };
            for slot in at.iter_mut().take(pairs) {
                *slot = self.stream.read_u8().ok_or(Failure)? as i8;
            }
        }
        let mut r_at = [0i8; 4];
        if refagg && r_template == 0 {
            for slot in &mut r_at {
                *slot = self.stream.read_u8().ok_or(Failure)? as i8;
            }
        }
        let num_ex = self.stream.read_u32().ok_or(Failure)?;
        let num_new = self.stream.read_u32().ok_or(Failure)?;
        if num_ex > MAX_SYMBOLS || num_new > MAX_SYMBOLS {
            return Err(Failure);
        }
        let Context { stream, segments, .. } = self;
        let mut found = Vec::with_capacity(segment.referred.len());
        for &number in &segment.referred {
            found.push(find_segment(globals, segments, number).ok_or(Failure)?);
        }
        let mut in_symbols: Vec<&Symbol> = Vec::new();
        let mut last: Option<&SymbolDict> = None;
        for referred in &found {
            if let (0, SegmentResult::Symbols(dict)) = (referred.kind, &referred.result) {
                in_symbols.extend(dict.symbols.iter());
                last = Some(dict);
            }
        }
        let tables = if huffman {
            let choice = |shift: u16, width: u16| (flags >> shift) & ((1 << width) - 1);
            let (dh, dw, bm_size, agg_inst) = (choice(2, 2), choice(4, 2), choice(6, 1), choice(7, 1));
            if dh == 2 || dw == 2 {
                return Err(Failure);
            }
            let mut next = 0;
            let mut pick = |choice: u16, standard: &[usize]| -> Result<HuffmanTable, Failure> {
                if let Some(&index) = standard.get(usize::from(choice)) {
                    return Ok(HuffmanTable::standard(index));
                }
                let table = referred_table(&found, next).ok_or(Failure)?;
                next += 1;
                Ok(table)
            };
            Some(SymbolTables {
                dh: pick(dh, &[4, 5])?,
                dw: pick(dw, &[2, 3])?,
                bm_size: pick(bm_size, &[1])?,
                // the table of the instance counts is looked up only by a dictionary that aggregates
                agg_inst: if refagg { pick(agg_inst, &[1])? } else { HuffmanTable::standard(1) },
            })
        } else {
            None
        };
        let gb_size = generic::context_count(template);
        let gr_size = refine::context_count(r_template);
        let (use_gb, use_gr) = (!huffman, refagg);
        let (mut gb, mut gr) = (Vec::new(), Vec::new());
        match last.filter(|_| flags & 0x0100 != 0) {
            Some(last) => {
                if use_gb {
                    gb = last.gb_contexts.clone();
                    if gb.len() != gb_size {
                        return Err(Failure);
                    }
                }
                if use_gr {
                    gr = last.gr_contexts.clone();
                    if gr.len() != gr_size {
                        return Err(Failure);
                    }
                }
            }
            None => {
                if use_gb {
                    gb = vec![ArithCx::default(); gb_size];
                }
                if use_gr {
                    gr = vec![ArithCx::default(); gr_size];
                }
            }
        }
        let decoder = SymbolDecoder { refagg, template, r_template, at, r_at, num_ex, num_new, in_symbols: &in_symbols };
        let symbols = match &tables {
            None => {
                let mut arith = ArithDecoder::new(stream.data(), stream.byte_index());
                let symbols = decoder.decode_arith(&mut arith, &mut gb, &mut gr).ok_or(Failure)?;
                stream.set_byte_index(arith.byte_index());
                stream.align_byte();
                stream.add_offset(2);
                symbols
            }
            Some(tables) => {
                let symbols = decoder.decode_huffman(stream, tables, &mut gr).ok_or(Failure)?;
                stream.align_byte();
                symbols
            }
        };
        let retain = flags & 0x0200 != 0;
        segment.result = SegmentResult::Symbols(SymbolDict {
            symbols,
            gb_contexts: if retain && use_gb { gb } else { Vec::new() },
            gr_contexts: if retain && use_gr { gr } else { Vec::new() },
        });
        Ok(Flow::Continue)
    }

    /// `ParseTable` (T.88 7.4.13): the custom Huffman table of a table segment.
    pub(super) fn parse_table(&mut self, segment: &mut Segment) -> Result<Flow, Failure> {
        let table = HuffmanTable::parse(&mut self.stream).ok_or(Failure)?;
        segment.result = SegmentResult::Table(table);
        self.stream.align_byte();
        Ok(Flow::Continue)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bitmap(rows: &[&str]) -> Symbol {
        let mut img = Image::new(rows[0].len() as i32, rows.len() as i32).unwrap();
        for (y, row) in rows.iter().enumerate() {
            for (x, ch) in row.chars().enumerate() {
                img.set_pixel(x as i32, y as i32, u8::from(ch == '#'));
            }
        }
        Symbol::Bitmap(img)
    }

    #[test]
    fn symbols_report_their_size() {
        assert_eq!((Symbol::Null.width(), Symbol::Null.height()), (0, 0));
        assert_eq!((Symbol::Empty.width(), Symbol::Empty.height()), (0, 0));
        let s = bitmap(&["##.", "#.."]);
        assert_eq!((s.width(), s.height()), (3, 2));
        assert!(Symbol::Empty.image().is_none());
    }

    #[test]
    fn symbol_sizes_are_bounded() {
        assert!(valid_symbol_size(0));
        assert!(valid_symbol_size(65535));
        assert!(!valid_symbol_size(65536));
        assert!(!valid_symbol_size(u32::MAX));
    }

    #[test]
    fn collective_bitmaps_are_cut_into_symbols() {
        let collective = match bitmap(&["##.#", "#..#"]) {
            Symbol::Bitmap(image) => image,
            _ => unreachable!(),
        };
        assert_eq!(cut(Some(&collective), 1, 2, 2).image().unwrap().get_pixel(0, 0), 1);
        assert_eq!(cut(Some(&collective), 0, 0, 2), Symbol::Empty);
        // an empty collective bitmap gives blank symbols
        assert_eq!(cut(None, 0, 2, 2).image().unwrap().data()[0], 0);
        assert_eq!(cut(None, 0, 0, 2), Symbol::Empty);
    }

    #[test]
    fn export_chooses_by_flags_and_input_symbols_are_copied() {
        let input = [&bitmap(&["#"]), &bitmap(&["##"])];
        let decoder = SymbolDecoder { refagg: false, template: 0, r_template: 0, at: [0; 8], r_at: [0; 4], num_ex: 2, num_new: 2, in_symbols: &input };
        let new = vec![bitmap(&["###"]), Symbol::Null];
        let exported = decoder.export(new.clone(), &[false, true, true, false]).unwrap();
        assert_eq!(exported, [bitmap(&["##"]), bitmap(&["###"])]);
        // more exported than the dictionary announces
        assert!(decoder.export(new, &[true, true, true, true]).is_none());
    }

    #[test]
    fn a_table_segment_is_read_and_referred_by_index() {
        let mut data = vec![0u8];
        data.extend_from_slice(&0i32.to_be_bytes());
        data.extend_from_slice(&2i32.to_be_bytes());
        // HTPS 1 bit, HTRS 1 bit: one line (prefix 1, 1 offset bit), lower (prefix 1), upper (prefix 0)...
        data.push(0b1_1_1_0_0000);
        let mut context = Context::new(&data);
        let mut segment = Segment { number: 1, kind: 53, referred: Vec::new(), data_length: data.len() as u32, result: SegmentResult::None };
        assert!(context.parse_table(&mut segment).is_ok());
        let found = [&segment];
        assert!(referred_table(&found, 0).is_some());
        assert!(referred_table(&found, 1).is_none());
    }
}
