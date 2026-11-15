//! The bi-level bitmap of the JBIG2 decoder (PDFium's `CJBig2_Image`): rows of 32-bit aligned bytes, the leftmost
//! pixel in the high bit of a byte, 1 = black, every pixel outside the bitmap reads 0.

use std::ops::Range;

/// The combination operators of a region onto the page (T.88 7.4.1.5), as the decoder applies them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComposeOp {
    Or,
    And,
    Xor,
    Xnor,
    Replace,
}

impl ComposeOp {
    /// The operator of the flags byte of a region's information field: the low three bits, where 4 is replace and the
    /// values 5 to 7 act as 1 to 3.
    pub fn from_flags(flags: u8) -> ComposeOp {
        match flags & 7 {
            4 => ComposeOp::Replace,
            n => match n & 3 {
                0 => ComposeOp::Or,
                1 => ComposeOp::And,
                2 => ComposeOp::Xor,
                _ => ComposeOp::Xnor,
            },
        }
    }

    fn apply(self, dst: u8, src: u8) -> u8 {
        match self {
            ComposeOp::Or => dst | src,
            ComposeOp::And => dst & src,
            ComposeOp::Xor => dst ^ src,
            ComposeOp::Xnor => 1 - (dst ^ src),
            ComposeOp::Replace => src,
        }
    }
}

/// `CJBig2_Image::kMaxImagePixels` and the byte bound that follows from it.
const MAX_IMAGE_PIXELS: i64 = i32::MAX as i64 - 31;
const MAX_IMAGE_BYTES: i64 = MAX_IMAGE_PIXELS / 8;

/// The widest and tallest region the decoder takes (`JBIG2_MAX_IMAGE_SIZE`).
const MAX_REGION_SIZE: i32 = 65535;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Image {
    width: i32,
    height: i32,
    stride: usize,
    data: Vec<u8>,
}

impl Image {
    /// `CJBig2_Image::IsValidImageSize`: the sizes a region may have.
    pub fn is_valid_region_size(width: i32, height: i32) -> bool {
        width > 0 && width <= MAX_REGION_SIZE && height > 0 && height <= MAX_REGION_SIZE
    }

    /// An all-white image, or `None` when the size is not allowed: not positive, or more bytes than the decoder
    /// allocates (`kMaxImageBytes`, which bounds the page buffer of the whole PDF image too).
    pub fn new(width: i32, height: i32) -> Option<Image> {
        if width <= 0 || height <= 0 || i64::from(width) > MAX_IMAGE_PIXELS {
            return None;
        }
        let stride = ((width as usize + 31) >> 5) << 2;
        let size = stride.checked_mul(height as usize)?;
        if size as i64 > MAX_IMAGE_BYTES {
            return None;
        }
        Some(Image {
            width,
            height,
            stride,
            data: vec![0; size],
        })
    }

    pub fn width(&self) -> i32 {
        self.width
    }

    pub fn height(&self) -> i32 {
        self.height
    }

    /// Bytes per row.
    pub fn stride(&self) -> usize {
        self.stride
    }

    pub fn data(&self) -> &[u8] {
        &self.data
    }

    pub fn data_mut(&mut self) -> &mut [u8] {
        &mut self.data
    }

    pub fn get_pixel(&self, x: i32, y: i32) -> u8 {
        if x < 0 || y < 0 || x >= self.width || y >= self.height {
            return 0;
        }
        (self.data[y as usize * self.stride + (x as usize >> 3)] >> (7 - (x & 7))) & 1
    }

    pub fn set_pixel(&mut self, x: i32, y: i32, value: u8) {
        if x < 0 || y < 0 || x >= self.width || y >= self.height {
            return;
        }
        let byte = &mut self.data[y as usize * self.stride + (x as usize >> 3)];
        let mask = 0x80u8 >> (x & 7);
        if value != 0 {
            *byte |= mask;
        } else {
            *byte &= !mask;
        }
    }

    /// Sets every byte, the padding bits of each row included.
    pub fn fill(&mut self, black: bool) {
        self.data.fill(if black { 0xff } else { 0x00 });
    }

    /// `CopyLine`: row `to` becomes a copy of row `from`, or white when `from` is outside the image.
    pub fn copy_line(&mut self, to: i32, from: i32) {
        if to < 0 || to >= self.height {
            return;
        }
        let to = to as usize * self.stride;
        if from < 0 || from >= self.height {
            self.data[to..to + self.stride].fill(0);
            return;
        }
        let from = from as usize * self.stride;
        self.data.copy_within(from..from + self.stride, to);
    }

    /// Composes this image onto `dst` with its origin at (`x`, `y`).
    pub fn compose_to(&self, dst: &mut Image, x: i32, y: i32, op: ComposeOp) {
        self.compose_rows_to(dst, x, y, op, 0..self.height);
    }

    /// Composes only the rows `rows` of this image onto `dst` (a region that was decoded as far as its data went).
    pub fn compose_rows_to(&self, dst: &mut Image, x: i32, y: i32, op: ComposeOp, rows: Range<i32>) {
        let (x, y) = (i64::from(x), i64::from(y));
        let sx0 = (-x).max(0);
        let sx1 = i64::from(self.width).min(i64::from(dst.width) - x);
        let sy0 = i64::from(rows.start).max(0).max(-y);
        let sy1 = i64::from(rows.end)
            .min(i64::from(self.height))
            .min(i64::from(dst.height) - y);
        if sx0 >= sx1 || sy0 >= sy1 {
            return;
        }
        for sy in sy0..sy1 {
            let src_row = &self.data[sy as usize * self.stride..(sy as usize + 1) * self.stride];
            let dy = (sy + y) as usize;
            let dst_row = &mut dst.data[dy * dst.stride..(dy + 1) * dst.stride];
            for sx in sx0..sx1 {
                let s = (src_row[sx as usize >> 3] >> (7 - (sx & 7))) & 1;
                let dx = (sx + x) as usize;
                let byte = &mut dst_row[dx >> 3];
                let mask = 0x80u8 >> (dx & 7);
                let d = u8::from(*byte & mask != 0);
                if op.apply(d, s) != 0 {
                    *byte |= mask;
                } else {
                    *byte &= !mask;
                }
            }
        }
    }

    /// The bit at column `x` of row `y` including the padding bits after the width (the rest of the row's bytes);
    /// 0 outside the rows and the row's bytes.
    pub fn padded_pixel(&self, x: i32, y: i32) -> u8 {
        if x < 0 || y < 0 || y >= self.height || x as usize >= self.stride * 8 {
            return 0;
        }
        (self.data[y as usize * self.stride + (x as usize >> 3)] >> (7 - (x & 7))) & 1
    }

    /// `SubImage`: the `width` x `height` part of this image whose top left pixel is (`x`, `y`). Whole bytes of the
    /// source are copied, so the bits after `width` up to the next byte boundary are the source's pixels there; what
    /// lies outside the source is white, and so is all of it when `x` or `y` is negative.
    pub fn sub_image(&self, x: i32, y: i32, width: i32, height: i32) -> Option<Image> {
        let mut out = Image::new(width, height)?;
        if x < 0 || y < 0 {
            return Some(out);
        }
        let copied = (width as usize).div_ceil(8) * 8;
        for row in 0..height {
            for col in 0..copied {
                let sx = i64::from(x) + col as i64;
                let sy = i64::from(y) + i64::from(row);
                if sx < 0 || sx > i64::from(i32::MAX) || sy < 0 || sy > i64::from(i32::MAX) {
                    continue;
                }
                if self.padded_pixel(sx as i32, sy as i32) == 1 {
                    let index = row as usize * out.stride + (col >> 3);
                    out.data[index] |= 0x80 >> (col & 7);
                }
            }
        }
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(rows: &[&str]) -> Image {
        let mut img = Image::new(rows[0].len() as i32, rows.len() as i32).unwrap();
        for (y, row) in rows.iter().enumerate() {
            for (x, ch) in row.chars().enumerate() {
                img.set_pixel(x as i32, y as i32, u8::from(ch == '#'));
            }
        }
        img
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

    #[test]
    fn pixels_outside_read_white_and_stride_is_32_bit_aligned() {
        let img = image(&["#.#", ".#."]);
        assert_eq!(img.stride(), 4);
        assert_eq!(img.get_pixel(-1, 0), 0);
        assert_eq!(img.get_pixel(3, 0), 0);
        assert_eq!(img.get_pixel(0, 2), 0);
        assert_eq!(img.get_pixel(2, 0), 1);
        assert_eq!(img.data()[0], 0b1010_0000);
    }

    #[test]
    fn sizes_are_bounded() {
        assert!(Image::new(0, 4).is_none());
        assert!(Image::new(4, -1).is_none());
        assert!(Image::new(65536, 1).is_some());
        assert!(Image::new(i32::MAX, 1).is_none());
        assert!(Image::new(65536, 65536).is_none());
        assert!(Image::new(8192, 262143).is_some());
        assert!(Image::new(8192, 262144).is_none());
        assert!(Image::is_valid_region_size(65535, 65535));
        assert!(!Image::is_valid_region_size(65536, 1));
        assert!(!Image::is_valid_region_size(0, 1));
    }

    #[test]
    fn operators_of_the_flags_byte() {
        let expected = [
            ComposeOp::Or,
            ComposeOp::And,
            ComposeOp::Xor,
            ComposeOp::Xnor,
            ComposeOp::Replace,
            ComposeOp::And,
            ComposeOp::Xor,
            ComposeOp::Xnor,
        ];
        for (flags, op) in expected.iter().enumerate() {
            assert_eq!(ComposeOp::from_flags(flags as u8), *op);
            assert_eq!(ComposeOp::from_flags(flags as u8 | 0xf8), *op);
        }
    }

    #[test]
    fn compose_clips_to_both_images() {
        let src = image(&["##..", "#.#."]);
        let mut dst = image(&["....", "...."]);
        src.compose_to(&mut dst, 3, 1, ComposeOp::Or);
        assert_eq!(render(&dst), ["....", "...#"]);
        let mut dst = image(&["....", "...."]);
        src.compose_to(&mut dst, -1, 0, ComposeOp::Or);
        assert_eq!(render(&dst), ["#...", ".#.."]);
        let mut dst = image(&["####", "####"]);
        src.compose_rows_to(&mut dst, 0, 0, ComposeOp::Replace, 0..1);
        assert_eq!(render(&dst), ["##..", "####"]);
    }

    #[test]
    fn operators_combine_pixel_by_pixel() {
        let src = image(&["##..", "#.#."]);
        let cases = [
            (ComposeOp::Or, ["####", "####"]),
            (ComposeOp::And, ["#...", "...."]),
            (ComposeOp::Xor, [".###", "####"]),
            (ComposeOp::Xnor, ["#...", "...."]),
            (ComposeOp::Replace, ["##..", "#.#."]),
        ];
        for (op, want) in cases {
            let mut dst = image(&["#.##", ".#.#"]);
            src.compose_to(&mut dst, 0, 0, op);
            assert_eq!(render(&dst), want, "{op:?}");
        }
    }

    #[test]
    fn copy_line_and_fill() {
        let mut img = image(&["#.#", "...", "..#"]);
        img.copy_line(1, 0);
        img.copy_line(2, -1);
        assert_eq!(render(&img), ["#.#", "#.#", "..."]);
        img.fill(true);
        assert_eq!(img.data()[0], 0xff);
        assert_eq!(img.get_pixel(2, 2), 1);
    }

    #[test]
    fn sub_image_pads_with_white() {
        let img = image(&["#.#.", ".#.#", "#..#"]);
        let sub = img.sub_image(2, 1, 3, 3).unwrap();
        assert_eq!(render(&sub), [".#.", ".#.", "..."]);
        // the bits up to the byte boundary after the width are the source's pixels
        let from_origin = img.sub_image(0, 0, 3, 3).unwrap();
        assert_eq!(from_origin.get_pixel(3, 1), 0);
        assert_eq!(from_origin.padded_pixel(3, 1), 1);
        assert_eq!(from_origin.padded_pixel(8, 1), 0);
        let sub = img.sub_image(-1, 0, 3, 3).unwrap();
        assert_eq!(render(&sub), ["...", "...", "..."]);
    }
}
