//! JBIG2 decoding as pdf.js 6.4.299 delivers it: PDFium's `fxcodec/jbig2` of `wasm/jbig2.wasm` behind the wrapper of
//! `Jbig2Stream`. The stream is the embedded organisation (segments one after the other, no file header), optionally
//! with a `JBIG2Globals` stream decoded first. The page has the size of the PDF image; the output is that image with
//! 0 = black, `(width + 7) / 8` bytes per row.
//!
//! This module reads the segments and carries out them: the page information, symbol dictionary, text region, pattern
//! dictionary, halftone region, generic region, generic refinement region and table segments and the end-of-page,
//! end-of-file and end-of-stripe segments. A segment that is not understood is skipped; a segment that fails fails the
//! whole stream, which the caller sees as [`CodecError::Unknown`].

pub mod generic;
pub mod halftone;
pub mod huffman;
pub mod image;
pub mod page;
pub mod refine;
pub mod symbols;
pub mod text;

use self::generic::GenericRegion;
use self::huffman::HuffmanTable;
use self::image::{ComposeOp, Image};
use self::page::{Page, PageInfo};
use self::refine::RefinementRegion;
use self::symbols::SymbolDict;
use super::CodecError;
use super::arith::{ArithCx, ArithDecoder};

/// `Jbig2Stream.stripFileHeader`: the bytes without the file header (signature, flags, page count) a stream of an
/// image may carry.
pub fn strip_file_header(bytes: &[u8]) -> &[u8] {
    const SIGNATURE: [u8; 8] = [0x97, 0x4a, 0x42, 0x32, 0x0d, 0x0a, 0x1a, 0x0a];
    if bytes.len() >= 9 && bytes[..8] == SIGNATURE {
        let header_length = if bytes[8] & 2 == 0 { 13 } else { 9 };
        return bytes.get(header_length..).unwrap_or(&[]);
    }
    bytes
}

/// Decodes a JBIG2 image stream of the PDF image `width` x `height` (the image dictionary's numbers converted to
/// 32-bit integers, see [`super::to_int32`]) with the optional `JBIG2Globals` data (both without file header, see
/// [`strip_file_header`]).
pub fn decode(data: &[u8], width: i32, height: i32, globals: Option<&[u8]>) -> Result<Vec<u8>, CodecError> {
    if width < 0 || height < 0 {
        return Err(CodecError::Unknown);
    }
    if width == 0 {
        return Err(CodecError::DivideByZero);
    }
    if height == 0 {
        return Err(CodecError::Unknown);
    }
    let mut page = Page::new(width, height).ok_or(CodecError::Unknown)?;
    let global_context = match globals.filter(|g| !g.is_empty()) {
        Some(bytes) => {
            let mut context = Context::new(bytes);
            match context.decode_sequential(None, None) {
                Ok(Outcome::Success) => Some(context),
                _ => return Err(CodecError::Unknown),
            }
        }
        None => None,
    };
    let mut context = Context::new(data);
    match context.decode_sequential(global_context.as_ref(), Some(&mut page)) {
        Ok(Outcome::Success) => Ok(page.into_output()),
        _ => Err(CodecError::Unknown),
    }
}

/// A cursor over the stream's bytes (PDFium's `CJBig2_BitStream`); it never moves past the end of the data.
pub struct BitStream<'a> {
    data: &'a [u8],
    byte_index: u32,
    bit_index: u8,
}

impl<'a> BitStream<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        BitStream {
            data,
            byte_index: 0,
            bit_index: 0,
        }
    }

    fn length(&self) -> u32 {
        u32::try_from(self.data.len()).unwrap_or(u32::MAX)
    }

    pub fn read_u8(&mut self) -> Option<u8> {
        if self.byte_index >= self.length() {
            return None;
        }
        let value = self.data[self.byte_index as usize];
        self.byte_index += 1;
        Some(value)
    }

    pub fn read_u16(&mut self) -> Option<u16> {
        if u64::from(self.byte_index) + 1 >= u64::from(self.length()) {
            return None;
        }
        let i = self.byte_index as usize;
        self.byte_index += 2;
        Some(u16::from_be_bytes([self.data[i], self.data[i + 1]]))
    }

    pub fn read_u32(&mut self) -> Option<u32> {
        if u64::from(self.byte_index) + 3 >= u64::from(self.length()) {
            return None;
        }
        let i = self.byte_index as usize;
        self.byte_index += 4;
        Some(u32::from_be_bytes([
            self.data[i],
            self.data[i + 1],
            self.data[i + 2],
            self.data[i + 3],
        ]))
    }

    /// The byte at the cursor, without moving it.
    fn peek_u8(&self) -> Option<u8> {
        self.data.get(self.byte_index as usize).copied()
    }

    /// Moves to the next byte boundary.
    pub fn align_byte(&mut self) {
        if self.bit_index != 0 {
            self.byte_index = self.byte_index.wrapping_add(1);
            self.bit_index = 0;
        }
    }

    pub fn byte_index(&self) -> u32 {
        self.byte_index
    }

    /// The cursor as a bit position.
    pub fn bit_position(&self) -> usize {
        self.byte_index as usize * 8 + usize::from(self.bit_index)
    }

    pub fn set_bit_position(&mut self, bits: usize) {
        self.byte_index = (bits >> 3) as u32;
        self.bit_index = (bits & 7) as u8;
    }

    /// Moves to byte `offset`, at most the end of the data.
    pub fn set_byte_index(&mut self, offset: u32) {
        self.byte_index = offset.min(self.length());
    }

    /// Moves `offset` bytes on, at most to the end of the data.
    pub fn add_offset(&mut self, offset: u32) {
        self.byte_index = self.byte_index.saturating_add(offset).min(self.length());
    }

    /// The bytes after the cursor.
    pub fn byte_left(&self) -> u32 {
        self.length() - self.byte_index
    }

    pub fn data(&self) -> &'a [u8] {
        self.data
    }
}

/// What a decoded segment leaves for the segments that refer to it.
pub enum SegmentResult {
    None,
    /// An intermediate region (types 4, 20, 36, 40).
    Image(Image),
    /// A symbol dictionary (type 0).
    Symbols(SymbolDict),
    /// A pattern dictionary (type 16): its patterns.
    Patterns(Vec<Image>),
    /// A custom Huffman table (type 53).
    Table(HuffmanTable),
}

/// A segment's header and what decoding it produced (`CJBig2_Segment`).
pub struct Segment {
    pub number: u32,
    pub kind: u8,
    pub referred: Vec<u32>,
    /// 0xFFFFFFFF when the length is unknown (an immediate generic region).
    pub data_length: u32,
    pub result: SegmentResult,
}

/// A segment header and its data are at least this long.
const MIN_SEGMENT_SIZE: u32 = 11;
/// The most segments one segment may refer to.
const MAX_REFERRED_SEGMENTS: u32 = 64;

/// A failure of the stream (PDFium's `JBig2_Result::kFailure`): the decode ends and the image is not delivered.
struct Failure;

/// Whether the segments go on.
enum Flow {
    Continue,
    /// The end-of-page or end-of-file segment: the rest of the stream is not read.
    End,
}

enum Outcome {
    Success,
    /// Nothing was left to read.
    EndReached,
}

/// A region segment's information field (T.88 7.4.1).
struct RegionInfo {
    width: i32,
    height: i32,
    x: i32,
    y: i32,
    flags: u8,
}

/// The segments of one stream, in the order they were read: the stream the globals are in, or the page's own.
struct Context<'a> {
    stream: BitStream<'a>,
    segments: Vec<Segment>,
    in_page: bool,
}

/// `FindSegmentByNumber`: the globals' segments first, then the stream's own.
fn find_segment<'s>(globals: Option<&'s Context<'_>>, own: &'s [Segment], number: u32) -> Option<&'s Segment> {
    globals
        .and_then(|g| g.segments.iter().find(|s| s.number == number))
        .or_else(|| own.iter().find(|s| s.number == number))
}

impl<'a> Context<'a> {
    fn new(data: &'a [u8]) -> Self {
        Context {
            stream: BitStream::new(data),
            segments: Vec::new(),
            in_page: false,
        }
    }

    /// `DecodeSequential`: reads segments until the data is used up or an end segment comes. `page` is the buffer the
    /// regions are composed onto (the globals have none).
    fn decode_sequential(
        &mut self,
        globals: Option<&Context<'_>>,
        mut page: Option<&mut Page>,
    ) -> Result<Outcome, Failure> {
        if self.stream.byte_left() == 0 {
            return Ok(Outcome::EndReached);
        }
        while self.stream.byte_left() >= MIN_SEGMENT_SIZE {
            let mut segment = self.parse_header()?;
            let data_start = self.stream.byte_index();
            if let Flow::End = self.parse_data(&mut segment, globals, page.as_deref_mut())? {
                return Ok(Outcome::Success);
            }
            if segment.data_length != u32::MAX {
                self.stream
                    .set_byte_index(data_start.saturating_add(segment.data_length));
            } else {
                self.stream.add_offset(4);
            }
            self.segments.push(segment);
        }
        Ok(Outcome::Success)
    }

    /// `ParseSegmentHeader` (T.88 7.2).
    fn parse_header(&mut self) -> Result<Segment, Failure> {
        let stream = &mut self.stream;
        let number = stream.read_u32().ok_or(Failure)?;
        let flags = stream.read_u8().ok_or(Failure)?;
        let first = stream.peek_u8().ok_or(Failure)?;
        let count;
        if first >> 5 == 7 {
            count = stream.read_u32().ok_or(Failure)? & 0x1fff_ffff;
            if count > MAX_REFERRED_SEGMENTS {
                return Err(Failure);
            }
            stream.add_offset((count + 1).div_ceil(8));
        } else {
            count = u32::from(stream.read_u8().ok_or(Failure)? >> 5);
        }
        let mut referred = Vec::with_capacity(count as usize);
        for _ in 0..count {
            let value = if number > 65536 {
                stream.read_u32().ok_or(Failure)?
            } else if number > 256 {
                u32::from(stream.read_u16().ok_or(Failure)?)
            } else {
                u32::from(stream.read_u8().ok_or(Failure)?)
            };
            if value >= number {
                return Err(Failure);
            }
            referred.push(value);
        }
        if flags & 0x40 != 0 {
            stream.read_u32().ok_or(Failure)?;
        } else {
            stream.read_u8().ok_or(Failure)?;
        }
        let data_length = stream.read_u32().ok_or(Failure)?;
        Ok(Segment {
            number,
            kind: flags & 0x3f,
            referred,
            data_length,
            result: SegmentResult::None,
        })
    }

    /// `ParseSegmentData`.
    fn parse_data(
        &mut self,
        segment: &mut Segment,
        globals: Option<&Context<'_>>,
        page: Option<&mut Page>,
    ) -> Result<Flow, Failure> {
        match segment.kind {
            0 => self.parse_symbol_dict(segment, globals),
            4 | 6 | 7 => {
                if !self.in_page {
                    return Err(Failure);
                }
                self.parse_text_region(segment, globals, page)
            }
            16 => self.parse_pattern_dict(segment),
            20 | 22 | 23 => {
                if !self.in_page {
                    return Err(Failure);
                }
                self.parse_halftone_region(segment, globals, page)
            }
            53 => self.parse_table(segment),
            36 | 38 | 39 => {
                if !self.in_page {
                    return Err(Failure);
                }
                self.parse_generic_region(segment, page)
            }
            40 | 42 | 43 => {
                if !self.in_page {
                    return Err(Failure);
                }
                self.parse_refinement_region(segment, globals, page)
            }
            48 => {
                let info = PageInfo::read(&mut self.stream).ok_or(Failure)?;
                match page {
                    Some(page) => page.fill(info.default_black),
                    None => {
                        if !info.can_allocate() {
                            return Err(Failure);
                        }
                    }
                }
                self.in_page = true;
                Ok(Flow::Continue)
            }
            49 => {
                self.in_page = false;
                Ok(Flow::End)
            }
            51 => Ok(Flow::End),
            50 | 52 | 62 => {
                self.stream.add_offset(segment.data_length);
                Ok(Flow::Continue)
            }
            _ => Ok(Flow::Continue),
        }
    }

    /// `ParseRegionInfo`.
    fn read_region_info(&mut self) -> Result<RegionInfo, Failure> {
        let stream = &mut self.stream;
        let width = stream.read_u32().ok_or(Failure)? as i32;
        let height = stream.read_u32().ok_or(Failure)? as i32;
        let x = stream.read_u32().ok_or(Failure)? as i32;
        let y = stream.read_u32().ok_or(Failure)? as i32;
        let flags = stream.read_u8().ok_or(Failure)?;
        Ok(RegionInfo {
            width,
            height,
            x,
            y,
            flags,
        })
    }

    /// What a decoded region becomes: the result of an intermediate segment (type `intermediate`), or composed onto the
    /// page.
    fn finish_region(
        segment: &mut Segment,
        image: Image,
        info: &RegionInfo,
        page: Option<&mut Page>,
        intermediate: u8,
    ) {
        if segment.kind == intermediate {
            segment.result = SegmentResult::Image(image);
        } else if let Some(page) = page {
            let rows = image.height();
            page.compose(&image, info.x, info.y, ComposeOp::from_flags(info.flags), 0..rows);
        }
    }

    /// `ParseGenericRegion` (T.88 7.4.6): types 36 (intermediate), 38 and 39 (immediate).
    fn parse_generic_region(&mut self, segment: &mut Segment, page: Option<&mut Page>) -> Result<Flow, Failure> {
        let info = self.read_region_info()?;
        let flags = self.stream.read_u8().ok_or(Failure)?;
        let mmr = flags & 1 != 0;
        let template = (flags >> 1) & 3;
        let tpgdon = flags & 8 != 0;
        let mut at = [0i8; 8];
        if !mmr {
            let pairs = if template == 0 { 8 } else { 2 };
            for slot in at.iter_mut().take(pairs) {
                *slot = self.stream.read_u8().ok_or(Failure)? as i8;
            }
        }
        if !Image::is_valid_region_size(info.width, info.height) {
            return Err(Failure);
        }
        let region = GenericRegion {
            width: info.width,
            height: info.height,
            template,
            tpgdon,
            skip: None,
            at,
        };
        let (image, rows) = if mmr {
            let (image, bits) = region
                .decode_mmr(self.stream.data(), self.stream.bit_position())
                .ok_or(Failure)?;
            self.stream.set_bit_position(bits);
            self.stream.align_byte();
            (image, info.height)
        } else {
            let mut contexts = vec![ArithCx::default(); generic::context_count(template)];
            let mut decoder = ArithDecoder::new(self.stream.data(), self.stream.byte_index());
            let decoded = region.decode_arith(&mut decoder, &mut contexts).ok_or(Failure)?;
            self.stream.set_byte_index(decoder.byte_index());
            self.stream.align_byte();
            self.stream.add_offset(2);
            (decoded.image, decoded.rows)
        };
        if segment.kind == 36 {
            segment.result = SegmentResult::Image(image);
        } else if let Some(page) = page {
            page.compose(&image, info.x, info.y, ComposeOp::from_flags(info.flags), 0..rows);
        }
        Ok(Flow::Continue)
    }

    /// `ParseGenericRefinementRegion` (T.88 7.4.7): types 40 (intermediate), 42 and 43 (immediate).
    fn parse_refinement_region(
        &mut self,
        segment: &mut Segment,
        globals: Option<&Context<'_>>,
        page: Option<&mut Page>,
    ) -> Result<Flow, Failure> {
        let info = self.read_region_info()?;
        let flags = self.stream.read_u8().ok_or(Failure)?;
        let template = flags & 1;
        let tpgron = flags & 2 != 0;
        let mut at = [0i8; 4];
        if template == 0 {
            for slot in &mut at {
                *slot = self.stream.read_u8().ok_or(Failure)? as i8;
            }
        }
        if !Image::is_valid_region_size(info.width, info.height) {
            return Err(Failure);
        }
        let blank;
        let page_reference;
        let reference: &Image = if segment.referred.is_empty() {
            // the part of the page the region covers
            page_reference = match page.as_deref() {
                Some(page) => page
                    .image()
                    .sub_image(info.x, info.y, info.width, info.height)
                    .ok_or(Failure)?,
                None => {
                    blank = Image::new(info.width, info.height).ok_or(Failure)?;
                    blank
                }
            };
            &page_reference
        } else {
            let mut found = None;
            for &number in &segment.referred {
                let referred = find_segment(globals, &self.segments, number).ok_or(Failure)?;
                if matches!(referred.kind, 4 | 20 | 36 | 40) {
                    found = Some(referred);
                    break;
                }
            }
            match &found.ok_or(Failure)?.result {
                SegmentResult::Image(image) => image,
                _ => return Err(Failure),
            }
        };
        let region = RefinementRegion {
            width: info.width,
            height: info.height,
            template,
            tpgron,
            reference,
            dx: 0,
            dy: 0,
            at,
        };
        let mut contexts = vec![ArithCx::default(); refine::context_count(template)];
        let mut decoder = ArithDecoder::new(self.stream.data(), self.stream.byte_index());
        let image = region.decode(&mut decoder, &mut contexts).ok_or(Failure)?;
        self.stream.set_byte_index(decoder.byte_index());
        self.stream.align_byte();
        self.stream.add_offset(2);
        if segment.kind == 40 {
            segment.result = SegmentResult::Image(image);
        } else if let Some(page) = page {
            page.compose(
                &image,
                info.x,
                info.y,
                ComposeOp::from_flags(info.flags),
                0..info.height,
            );
        }
        Ok(Flow::Continue)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segment(number: u32, kind: u8, data: &[u8]) -> Vec<u8> {
        let mut out = number.to_be_bytes().to_vec();
        out.push(kind);
        out.push(0);
        out.push(1);
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        out.extend_from_slice(data);
        out
    }

    fn page_info(flags: u8) -> Vec<u8> {
        let mut data = Vec::new();
        data.extend_from_slice(&8u32.to_be_bytes());
        data.extend_from_slice(&2u32.to_be_bytes());
        data.extend_from_slice(&[0; 8]);
        data.push(flags);
        data.extend_from_slice(&[0, 0]);
        segment(0, 48, &data)
    }

    /// A generic region segment of 8x2 pixels at (`x`, 0): row 0 white, row 1 black at x 2..5, MMR coded.
    fn mmr_region(kind: u8, x: u32, op: u8) -> Vec<u8> {
        let mut data = Vec::new();
        data.extend_from_slice(&8u32.to_be_bytes());
        data.extend_from_slice(&2u32.to_be_bytes());
        data.extend_from_slice(&x.to_be_bytes());
        data.extend_from_slice(&0u32.to_be_bytes());
        data.push(op);
        data.push(1);
        data.extend_from_slice(&[0b1001_0111, 0b1010_0000]);
        segment(1, kind, &data)
    }

    fn rows(out: &[u8], width: usize) -> Vec<String> {
        let pitch = width.div_ceil(8);
        out.chunks(pitch)
            .map(|row| {
                (0..width)
                    .map(|x| if row[x / 8] >> (7 - x % 8) & 1 == 1 { '.' } else { '#' })
                    .collect()
            })
            .collect()
    }

    #[test]
    fn strips_the_file_header() {
        let mut with_pages = vec![0x97, 0x4a, 0x42, 0x32, 0x0d, 0x0a, 0x1a, 0x0a, 1, 0, 0, 0, 1];
        with_pages.extend_from_slice(&[9, 9]);
        assert_eq!(strip_file_header(&with_pages), [9, 9]);
        let mut unknown_pages = vec![0x97, 0x4a, 0x42, 0x32, 0x0d, 0x0a, 0x1a, 0x0a, 3];
        unknown_pages.extend_from_slice(&[7]);
        assert_eq!(strip_file_header(&unknown_pages), [7]);
        assert_eq!(strip_file_header(&[1, 2, 3]), [1, 2, 3]);
        assert_eq!(strip_file_header(&[0x97, 0x4a]), [0x97, 0x4a]);
    }

    #[test]
    fn decodes_an_mmr_region_onto_the_page() {
        let mut stream = page_info(0);
        stream.extend(mmr_region(38, 0, 0));
        let out = decode(&stream, 8, 2, None).unwrap();
        assert_eq!(rows(&out, 8), ["........", "..###..."]);
    }

    #[test]
    fn the_region_is_clipped_and_the_page_has_the_pdf_images_size() {
        let mut stream = page_info(0);
        stream.extend(mmr_region(38, 4, 0));
        assert_eq!(rows(&decode(&stream, 8, 2, None).unwrap(), 8), ["........", "......##"]);
        // a larger PDF image than the page information says
        let wide = decode(&stream, 12, 3, None).unwrap();
        assert_eq!(rows(&wide, 12), ["............", "......###...", "............"]);
    }

    #[test]
    fn operators_and_the_default_pixel() {
        let mut black = page_info(4);
        black.extend(mmr_region(38, 0, 0));
        assert_eq!(rows(&decode(&black, 8, 2, None).unwrap(), 8), ["########", "########"]);
        let mut replace = page_info(4);
        replace.extend(mmr_region(38, 0, 4));
        assert_eq!(
            rows(&decode(&replace, 8, 2, None).unwrap(), 8),
            ["........", "..###..."]
        );
        let mut xor = page_info(4);
        xor.extend(mmr_region(38, 0, 2));
        assert_eq!(rows(&decode(&xor, 8, 2, None).unwrap(), 8), ["########", "##...###"]);
    }

    #[test]
    fn streams_end_at_the_end_of_page() {
        let mut stream = page_info(0);
        stream.extend(segment(2, 49, &[]));
        stream.extend(mmr_region(38, 0, 0));
        assert_eq!(rows(&decode(&stream, 8, 2, None).unwrap(), 8), ["........", "........"]);
    }

    #[test]
    fn a_region_before_the_page_information_fails() {
        assert_eq!(decode(&mmr_region(38, 0, 0), 8, 2, None), Err(CodecError::Unknown));
        assert_eq!(decode(&[], 8, 2, None), Err(CodecError::Unknown));
    }

    #[test]
    fn short_data_is_not_an_error_and_an_unknown_segment_is_skipped() {
        assert_eq!(
            rows(&decode(&[1, 2, 3], 8, 2, None).unwrap(), 8),
            ["........", "........"]
        );
        let mut stream = page_info(0);
        stream.extend(segment(2, 63, &[1, 2, 3]));
        stream.extend(mmr_region(38, 0, 0));
        assert_eq!(rows(&decode(&stream, 8, 2, None).unwrap(), 8)[1], "..###...");
    }

    #[test]
    fn a_malformed_dictionary_or_region_fails_the_stream() {
        let mut stream = page_info(0);
        stream.extend(segment(2, 0, &[0; 4]));
        assert_eq!(decode(&stream, 8, 2, None), Err(CodecError::Unknown));
        // a text region before the page information
        assert_eq!(decode(&segment(2, 6, &[0; 30]), 8, 2, None), Err(CodecError::Unknown));
        // a halftone region that refers to nothing
        let mut halftone = page_info(0);
        halftone.extend(segment(2, 22, &[0; 30]));
        assert_eq!(decode(&halftone, 8, 2, None), Err(CodecError::Unknown));
    }

    #[test]
    fn globals_are_read_first_and_cannot_hold_regions() {
        let mut globals = page_info(0);
        globals.extend(segment(3, 62, &[0; 4]));
        let mut stream = page_info(0);
        stream.extend(mmr_region(38, 0, 0));
        assert!(decode(&stream, 8, 2, Some(&globals)).is_ok());
        assert_eq!(
            decode(&stream, 8, 2, Some(&mmr_region(38, 0, 0))),
            Err(CodecError::Unknown)
        );
        // a few bytes of globals are less than a segment and are ignored
        assert!(decode(&stream, 8, 2, Some(&[1, 2, 3])).is_ok());
    }

    #[test]
    fn dimensions_are_checked_as_the_wrapper_checks_them() {
        let stream = page_info(0);
        assert_eq!(decode(&stream, 0, 2, None), Err(CodecError::DivideByZero));
        assert_eq!(decode(&stream, 0, 0, None), Err(CodecError::DivideByZero));
        assert_eq!(decode(&stream, 8, 0, None), Err(CodecError::Unknown));
        assert_eq!(decode(&stream, -1, 2, None), Err(CodecError::Unknown));
        assert_eq!(decode(&stream, 0, -1, None), Err(CodecError::Unknown));
        assert_eq!(decode(&stream, 100_000, 100_000, None), Err(CodecError::Unknown));
    }

    #[test]
    fn long_form_headers_skip_the_retain_bits() {
        // segment 300 refers to nine segments: the count is in a 32-bit field and two bytes of retain bits follow
        let mut stream = page_info(0);
        let mut header = 300u32.to_be_bytes().to_vec();
        header.push(62);
        header.extend_from_slice(&(0xe000_0000u32 | 9).to_be_bytes());
        header.extend_from_slice(&[0, 0]);
        for n in 1..=9u16 {
            header.extend_from_slice(&n.to_be_bytes());
        }
        header.push(1);
        header.extend_from_slice(&0u32.to_be_bytes());
        stream.extend(header);
        stream.extend(mmr_region(38, 0, 0));
        assert_eq!(rows(&decode(&stream, 8, 2, None).unwrap(), 8)[1], "..###...");
    }
}
