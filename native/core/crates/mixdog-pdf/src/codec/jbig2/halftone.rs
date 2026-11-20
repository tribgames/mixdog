//! Pattern dictionaries (T.88 6.7, PDFium's `CJBig2_PDDProc`) and halftone regions (T.88 6.6, `CJBig2_HTRDProc`) with
//! their segments (types 16, 20, 22 and 23).

use super::generic::{self, GenericRegion};
use super::image::{ComposeOp, Image};
use super::{BitStream, Context, Failure, Flow, Segment, SegmentResult, find_segment};
use crate::codec::arith::{ArithCx, ArithDecoder};

/// The most patterns a dictionary holds (`JBIG2_MAX_PATTERN_INDEX` + 1).
const MAX_GRAY_MAX: u32 = 65535;

/// `HBPP`: the bits of a gray value for `count` patterns.
fn gray_bits(count: u32) -> u32 {
    let mut bits = 1;
    while (1u64 << bits) < u64::from(count) {
        bits += 1;
    }
    bits
}

/// A pattern dictionary's parameters.
struct PatternDict {
    pattern_width: u8,
    pattern_height: u8,
    gray_max: u32,
    mmr: bool,
    template: u8,
}

impl PatternDict {
    /// The collective bitmap's generic region: `gray_max + 1` patterns side by side.
    fn region(&self) -> GenericRegion<'static> {
        let mut at = [0i8; 8];
        at[0] = -(i32::from(self.pattern_width)) as i8;
        if self.template == 0 {
            at[2..].copy_from_slice(&[-3, -1, 2, -2, -2, -2]);
        }
        GenericRegion {
            width: ((u64::from(self.gray_max) + 1) * u64::from(self.pattern_width)).min(i32::MAX as u64) as i32,
            height: i32::from(self.pattern_height),
            template: self.template,
            tpgdon: false,
            skip: None,
            at,
        }
    }

    /// The patterns cut out of the collective bitmap.
    fn cut(&self, collective: &Image) -> Option<Vec<Image>> {
        (0..=self.gray_max)
            .map(|gray| collective.sub_image((gray * u32::from(self.pattern_width)) as i32, 0, i32::from(self.pattern_width), i32::from(self.pattern_height)))
            .collect()
    }

    /// `DecodeArith`.
    fn decode_arith(&self, decoder: &mut ArithDecoder, cx: &mut [ArithCx]) -> Option<Vec<Image>> {
        let collective = self.region().decode_arith(decoder, cx)?;
        self.cut(&collective.image)
    }

    /// `DecodeMMR`.
    fn decode_mmr(&self, stream: &mut BitStream) -> Option<Vec<Image>> {
        let (collective, bits) = self.region().decode_mmr(stream.data(), stream.bit_position())?;
        stream.set_bit_position(bits);
        self.cut(&collective)
    }
}

/// A halftone region's parameters.
struct HalftoneRegion<'a> {
    width: i32,
    height: i32,
    mmr: bool,
    template: u8,
    enable_skip: bool,
    comb_op: ComposeOp,
    def_pixel: bool,
    grid_width: u32,
    grid_height: u32,
    grid_x: i32,
    grid_y: i32,
    step_x: u16,
    step_y: u16,
    patterns: &'a [Image],
}

impl HalftoneRegion<'_> {
    /// The position of the grid cell (`m`, `n`): `(HGX + m * HRY + n * HRX) >> 8` and `(HGY + m * HRX - n * HRY) >> 8`.
    fn cell(&self, m: u32, n: u32) -> (i32, i32) {
        let (m, n) = (m as i32, n as i32);
        let (rx, ry) = (i32::from(self.step_x), i32::from(self.step_y));
        let x = self.grid_x.wrapping_add(m.wrapping_mul(ry)).wrapping_add(n.wrapping_mul(rx)) >> 8;
        let y = self.grid_y.wrapping_add(m.wrapping_mul(rx)).wrapping_sub(n.wrapping_mul(ry)) >> 8;
        (x, y)
    }

    fn pattern_size(&self) -> (i32, i32) {
        (self.patterns[0].width(), self.patterns[0].height())
    }

    /// The cells whose pattern lies wholly outside the region (HSKIP).
    fn skip_mask(&self) -> Option<Image> {
        let mut skip = Image::new(self.grid_width as i32, self.grid_height as i32)?;
        let (pattern_width, pattern_height) = self.pattern_size();
        for m in 0..self.grid_height {
            for n in 0..self.grid_width {
                let (x, y) = self.cell(m, n);
                let outside = x + pattern_width <= 0 || x >= self.width || y + pattern_height <= 0 || y >= self.height;
                skip.set_pixel(n as i32, m as i32, u8::from(outside));
            }
        }
        Some(skip)
    }

    /// `DecodeImage`: the region from the gray-scale planes, the least significant first.
    fn compose(&self, planes: &[Image]) -> Option<Image> {
        let mut region = Image::new(self.width, self.height)?;
        region.fill(self.def_pixel);
        let last = self.patterns.len() as u32 - 1;
        for m in 0..self.grid_height {
            for n in 0..self.grid_width {
                let mut gray = 0u32;
                for (bit, plane) in planes.iter().enumerate() {
                    gray |= u32::from(plane.get_pixel(n as i32, m as i32)) << bit;
                }
                let (x, y) = self.cell(m, n);
                self.patterns[gray.min(last) as usize].compose_to(&mut region, x, y, self.comb_op);
            }
        }
        Some(region)
    }

    /// `DecodeArith`: the gray-scale image of `HBPP` arithmetic coded bitplanes (T.88 Annex C).
    fn decode_arith(&self, decoder: &mut ArithDecoder, cx: &mut [ArithCx]) -> Option<Image> {
        let skip = if self.enable_skip { self.skip_mask() } else { None };
        let bits = gray_bits(self.patterns.len() as u32);
        let mut at = [0i8; 8];
        at[0] = if self.template <= 1 { 3 } else { 2 };
        at[1] = -1;
        if self.template == 0 {
            at[2..].copy_from_slice(&[-3, -1, 2, -2, -2, -2]);
        }
        let plane =
            GenericRegion { width: self.grid_width as i32, height: self.grid_height as i32, template: self.template, tpgdon: false, skip: skip.as_ref(), at };
        // decoded from the most significant plane down; each is the exclusive or of itself and the one above
        let mut planes: Vec<Image> = Vec::with_capacity(bits as usize);
        for _ in 0..bits {
            let mut image = plane.decode_arith(decoder, cx)?.image;
            if let Some(above) = planes.last() {
                above.compose_to(&mut image, 0, 0, ComposeOp::Xor);
            }
            planes.push(image);
        }
        planes.reverse();
        self.compose(&planes)
    }

    /// `DecodeMMR`: the gray-scale image of `HBPP` MMR coded bitplanes, each followed by the end-of-block bytes.
    fn decode_mmr(&self, stream: &mut BitStream) -> Option<Image> {
        let bits = gray_bits(self.patterns.len() as u32);
        let plane = GenericRegion { width: self.grid_width as i32, height: self.grid_height as i32, template: 0, tpgdon: false, skip: None, at: [0; 8] };
        let mut planes: Vec<Image> = Vec::with_capacity(bits as usize);
        for _ in 0..bits {
            let (mut image, position) = plane.decode_mmr(stream.data(), stream.bit_position())?;
            stream.set_bit_position(position);
            stream.align_byte();
            stream.add_offset(3);
            if let Some(above) = planes.last() {
                above.compose_to(&mut image, 0, 0, ComposeOp::Xor);
            }
            planes.push(image);
        }
        planes.reverse();
        self.compose(&planes)
    }
}

impl Context<'_> {
    /// `ParsePatternDict` (T.88 7.4.4).
    pub(super) fn parse_pattern_dict(&mut self, segment: &mut Segment) -> Result<Flow, Failure> {
        let flags = self.stream.read_u8().ok_or(Failure)?;
        let pattern_width = self.stream.read_u8().ok_or(Failure)?;
        let pattern_height = self.stream.read_u8().ok_or(Failure)?;
        let gray_max = self.stream.read_u32().ok_or(Failure)?;
        if gray_max > MAX_GRAY_MAX {
            return Err(Failure);
        }
        let dict = PatternDict { pattern_width, pattern_height, gray_max, mmr: flags & 1 != 0, template: (flags >> 1) & 3 };
        let patterns = if dict.mmr {
            let patterns = dict.decode_mmr(&mut self.stream).ok_or(Failure)?;
            self.stream.align_byte();
            patterns
        } else {
            let mut cx = vec![ArithCx::default(); generic::context_count(dict.template)];
            let mut decoder = ArithDecoder::new(self.stream.data(), self.stream.byte_index());
            let patterns = dict.decode_arith(&mut decoder, &mut cx).ok_or(Failure)?;
            self.stream.set_byte_index(decoder.byte_index());
            self.stream.align_byte();
            self.stream.add_offset(2);
            patterns
        };
        segment.result = SegmentResult::Patterns(patterns);
        Ok(Flow::Continue)
    }

    /// `ParseHalftoneRegion` (T.88 7.4.5): types 20 (intermediate), 22 and 23 (immediate).
    pub(super) fn parse_halftone_region(
        &mut self,
        segment: &mut Segment,
        globals: Option<&Context<'_>>,
        page: Option<&mut super::page::Page>,
    ) -> Result<Flow, Failure> {
        let info = self.read_region_info()?;
        let flags = self.stream.read_u8().ok_or(Failure)?;
        let grid_width = self.stream.read_u32().ok_or(Failure)?;
        let grid_height = self.stream.read_u32().ok_or(Failure)?;
        let grid_x = self.stream.read_u32().ok_or(Failure)? as i32;
        let grid_y = self.stream.read_u32().ok_or(Failure)? as i32;
        let step_x = self.stream.read_u16().ok_or(Failure)?;
        let step_y = self.stream.read_u16().ok_or(Failure)?;
        if !Image::is_valid_region_size(grid_width as i32, grid_height as i32) || !Image::is_valid_region_size(info.width, info.height) {
            return Err(Failure);
        }
        if segment.referred.len() != 1 {
            return Err(Failure);
        }
        let Context { stream, segments, .. } = self;
        let referred = find_segment(globals, segments, segment.referred[0]).ok_or(Failure)?;
        let patterns = match (&referred.result, referred.kind) {
            (SegmentResult::Patterns(patterns), 16) if !patterns.is_empty() => patterns,
            _ => return Err(Failure),
        };
        let region = HalftoneRegion {
            width: info.width,
            height: info.height,
            mmr: flags & 1 != 0,
            template: (flags >> 1) & 3,
            enable_skip: (flags >> 3) & 1 != 0,
            comb_op: ComposeOp::from_flags((flags >> 4) & 7),
            def_pixel: (flags >> 7) & 1 != 0,
            grid_width,
            grid_height,
            grid_x,
            grid_y,
            step_x,
            step_y,
            patterns,
        };
        let image = if region.mmr {
            let image = region.decode_mmr(stream).ok_or(Failure)?;
            stream.align_byte();
            image
        } else {
            let mut cx = vec![ArithCx::default(); generic::context_count(region.template)];
            let mut decoder = ArithDecoder::new(stream.data(), stream.byte_index());
            let image = region.decode_arith(&mut decoder, &mut cx).ok_or(Failure)?;
            stream.set_byte_index(decoder.byte_index());
            stream.align_byte();
            stream.add_offset(2);
            image
        };
        Self::finish_region(segment, image, &info, page, 20);
        Ok(Flow::Continue)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pattern(rows: &[&str]) -> Image {
        let mut img = Image::new(rows[0].len() as i32, rows.len() as i32).unwrap();
        for (y, row) in rows.iter().enumerate() {
            for (x, ch) in row.chars().enumerate() {
                img.set_pixel(x as i32, y as i32, u8::from(ch == '#'));
            }
        }
        img
    }

    fn render(img: &Image) -> Vec<String> {
        (0..img.height()).map(|y| (0..img.width()).map(|x| if img.get_pixel(x, y) == 1 { '#' } else { '.' }).collect()).collect()
    }

    fn halftone<'a>(patterns: &'a [Image], grid: (u32, u32), step: (u16, u16), origin: (i32, i32)) -> HalftoneRegion<'a> {
        HalftoneRegion {
            width: 8,
            height: 4,
            mmr: false,
            template: 0,
            enable_skip: false,
            comb_op: ComposeOp::Or,
            def_pixel: false,
            grid_width: grid.0,
            grid_height: grid.1,
            grid_x: origin.0,
            grid_y: origin.1,
            step_x: step.0,
            step_y: step.1,
            patterns,
        }
    }

    #[test]
    fn gray_bits_cover_the_patterns() {
        assert_eq!(gray_bits(1), 1);
        assert_eq!(gray_bits(2), 1);
        assert_eq!(gray_bits(3), 2);
        assert_eq!(gray_bits(4), 2);
        assert_eq!(gray_bits(5), 3);
        assert_eq!(gray_bits(65536), 16);
    }

    #[test]
    fn grid_cells_follow_the_grid_vector() {
        let patterns = [pattern(&["..", ".."])];
        // a grid stepping 2 pixels to the right per column and 2 down per row (HRX = 512, HRY = 0)
        let region = halftone(&patterns, (4, 2), (512, 0), (0, 0));
        assert_eq!(region.cell(0, 0), (0, 0));
        assert_eq!(region.cell(0, 3), (6, 0));
        assert_eq!(region.cell(1, 0), (0, 2));
        // a rotated grid moves up by HRY per column
        let rotated = halftone(&patterns, (2, 2), (256, 256), (0, 0));
        assert_eq!(rotated.cell(0, 1), (1, -1));
    }

    #[test]
    fn gray_values_choose_the_patterns_and_clamp_to_the_last() {
        let patterns = [pattern(&["..", ".."]), pattern(&["#.", ".#"]), pattern(&["##", "##"])];
        let region = halftone(&patterns, (4, 2), (512, 0), (0, 0));
        // two planes: the low plane then the high one; gray values 0 1 2 3 / 3 2 1 0 (3 clamps to the last pattern)
        let low = pattern(&[".#.#", "#.#."]);
        let high = pattern(&["..##", "##.."]);
        let out = region.compose(&[low, high]).unwrap();
        assert_eq!(render(&out), ["..#.####", "...#####", "#####...", "####.#.."]);
    }

    #[test]
    fn the_pattern_dictionary_region_puts_the_first_adaptive_pixel_one_pattern_to_the_left() {
        let dict = PatternDict { pattern_width: 4, pattern_height: 4, gray_max: 15, mmr: false, template: 0 };
        let region = dict.region();
        assert_eq!((region.width, region.height), (64, 4));
        assert_eq!(region.at, [-4, 0, -3, -1, 2, -2, -2, -2]);
        let other = PatternDict { template: 2, ..dict };
        assert_eq!(other.region().at, [-4, 0, 0, 0, 0, 0, 0, 0]);
        // the offset is stored in a signed byte
        let wide = PatternDict { pattern_width: 255, ..other };
        assert_eq!(wide.region().at[0], 1);
    }

    #[test]
    fn patterns_are_cut_from_the_collective_bitmap() {
        let dict = PatternDict { pattern_width: 2, pattern_height: 2, gray_max: 1, mmr: false, template: 0 };
        let collective = pattern(&["#..#", ".##."]);
        let patterns = dict.cut(&collective).unwrap();
        assert_eq!(render(&patterns[0]), ["#.", ".#"]);
        assert_eq!(render(&patterns[1]), [".#", "#."]);
    }

    #[test]
    fn skipped_cells_are_those_outside_the_region() {
        let patterns = [pattern(&["##", "##"])];
        let mut region = halftone(&patterns, (4, 1), (256 * 5, 0), (0, 0));
        region.width = 8;
        let skip = region.skip_mask().unwrap();
        // columns at x = 0, 5, 10, 15: the cells at 10 and 15 lie beyond the width of 8
        assert_eq!((0..4).map(|n| skip.get_pixel(n, 0)).collect::<Vec<_>>(), [0, 0, 1, 1]);
    }
}
