//! Generic region decoding (T.88 6.2): arithmetic coded with templates 0 to 3, typical prediction and adaptive
//! template pixels, and MMR coded. The decoder stops where PDFium's does when the data runs out.

use super::image::Image;
use crate::codec::arith::{ArithCx, ArithDecoder};
use crate::codec::ccitt;

/// A generic region's parameters (PDFium's `CJBig2_GRDProc`).
pub struct GenericRegion<'a> {
    pub width: i32,
    pub height: i32,
    /// 0 to 3.
    pub template: u8,
    /// Typical prediction (TPGDON).
    pub tpgdon: bool,
    /// The pixels that are not coded (halftone regions): they decode as 0.
    pub skip: Option<&'a Image>,
    /// The adaptive template pixels: four (x, y) pairs for template 0, the first pair for the others.
    pub at: [i8; 8],
}

/// A region as far as it was decoded.
pub struct Decoded {
    pub image: Image,
    /// The rows `0..rows` are complete; fewer than the height means the data ran out in row `rows`.
    pub rows: i32,
}

/// The context of the typical-prediction decision of each template.
const LTP_CONTEXT: [usize; 4] = [0x9b25, 0x0795, 0x00e5, 0x0195];

/// The number of contexts a region of `template` uses.
pub fn context_count(template: u8) -> usize {
    match template {
        0 => 1 << 16,
        1 => 1 << 13,
        _ => 1 << 10,
    }
}

/// Where the template's pixels sit in the context when the adaptive pixels are at their default places, so that the
/// two rows above the pixel are windows that slide along: bits of the pixels left of the current one, then the window
/// of the row above (rightmost offset `right_1`, `mask_1`, at bit `shift_1`) and of the row two above.
struct Windows {
    left_mask: u32,
    right_1: i32,
    mask_1: u32,
    shift_1: u32,
    right_2: i32,
    mask_2: u32,
    shift_2: u32,
}

const WINDOWS: [Windows; 4] = [
    Windows {
        left_mask: 0x0f,
        right_1: 3,
        mask_1: 0x7f,
        shift_1: 4,
        right_2: 2,
        mask_2: 0x1f,
        shift_2: 11,
    },
    Windows {
        left_mask: 0x07,
        right_1: 3,
        mask_1: 0x3f,
        shift_1: 3,
        right_2: 2,
        mask_2: 0x0f,
        shift_2: 9,
    },
    Windows {
        left_mask: 0x03,
        right_1: 2,
        mask_1: 0x1f,
        shift_1: 2,
        right_2: 1,
        mask_2: 0x07,
        shift_2: 7,
    },
    Windows {
        left_mask: 0x0f,
        right_1: 2,
        mask_1: 0x3f,
        shift_1: 4,
        right_2: 0,
        mask_2: 0,
        shift_2: 0,
    },
];

impl GenericRegion<'_> {
    /// True when the adaptive pixels are where the standard puts them and no pixel is skipped: the case PDFium decodes
    /// a byte at a time (a byte that was not finished when the data ran out is left out of the image).
    fn default_pixels(&self) -> bool {
        let at = &self.at;
        self.skip.is_none()
            && match self.template {
                0 => at[..8] == [3, -1, -3, -1, 2, -2, -2, -2],
                1 => at[..2] == [3, -1],
                _ => at[..2] == [2, -1],
            }
    }

    /// The context of pixel (`x`, `y`) with the adaptive pixels anywhere (T.88 figures 3 to 6).
    fn context(&self, img: &Image, x: i32, y: i32) -> usize {
        let p = |dx: i32, dy: i32| usize::from(img.get_pixel(x + dx, y + dy));
        let at = |i: usize| p(i32::from(self.at[2 * i]), i32::from(self.at[2 * i + 1]));
        match self.template {
            0 => {
                p(-1, 0)
                    | (p(-2, 0) << 1)
                    | (p(-3, 0) << 2)
                    | (p(-4, 0) << 3)
                    | (at(0) << 4)
                    | (p(2, -1) << 5)
                    | (p(1, -1) << 6)
                    | (p(0, -1) << 7)
                    | (p(-1, -1) << 8)
                    | (p(-2, -1) << 9)
                    | (at(1) << 10)
                    | (at(2) << 11)
                    | (p(1, -2) << 12)
                    | (p(0, -2) << 13)
                    | (p(-1, -2) << 14)
                    | (at(3) << 15)
            }
            1 => {
                p(-1, 0)
                    | (p(-2, 0) << 1)
                    | (p(-3, 0) << 2)
                    | (at(0) << 3)
                    | (p(2, -1) << 4)
                    | (p(1, -1) << 5)
                    | (p(0, -1) << 6)
                    | (p(-1, -1) << 7)
                    | (p(-2, -1) << 8)
                    | (p(2, -2) << 9)
                    | (p(1, -2) << 10)
                    | (p(0, -2) << 11)
                    | (p(-1, -2) << 12)
            }
            2 => {
                p(-1, 0)
                    | (p(-2, 0) << 1)
                    | (at(0) << 2)
                    | (p(1, -1) << 3)
                    | (p(0, -1) << 4)
                    | (p(-1, -1) << 5)
                    | (p(-2, -1) << 6)
                    | (p(1, -2) << 7)
                    | (p(0, -2) << 8)
                    | (p(-1, -2) << 9)
            }
            _ => {
                p(-1, 0)
                    | (p(-2, 0) << 1)
                    | (p(-3, 0) << 2)
                    | (p(-4, 0) << 3)
                    | (at(0) << 4)
                    | (p(1, -1) << 5)
                    | (p(0, -1) << 6)
                    | (p(-1, -1) << 7)
                    | (p(-2, -1) << 8)
                    | (p(-3, -1) << 9)
            }
        }
    }

    /// Decodes the region from `decoder` with the context table `cx` (`context_count(template)` entries, shared by the
    /// regions of one segment). `None` when the region's size is not one the decoder allocates.
    pub fn decode_arith(&self, decoder: &mut ArithDecoder, cx: &mut [ArithCx]) -> Option<Decoded> {
        if !Image::is_valid_region_size(self.width, self.height) {
            return None;
        }
        let mut img = Image::new(self.width, self.height)?;
        let template = usize::from(self.template.min(3));
        let fast = self.default_pixels();
        let w = &WINDOWS[template];
        let mut ltp = 0u8;
        for y in 0..self.height {
            if self.tpgdon {
                if decoder.is_complete() {
                    return Some(Decoded { image: img, rows: y });
                }
                ltp ^= decoder.decode(&mut cx[LTP_CONTEXT[template]]);
            }
            if ltp == 1 {
                img.copy_line(y, y - 1);
                continue;
            }
            let (mut left, mut win_1, mut win_2) = (0u32, 0u32, 0u32);
            if fast {
                for i in 0..w.right_1 {
                    win_1 = (win_1 << 1) | u32::from(img.get_pixel(i, y - 1));
                }
                for i in 0..w.right_2 {
                    win_2 = (win_2 << 1) | u32::from(img.get_pixel(i, y - 2));
                }
            }
            for x in 0..self.width {
                let context = if fast {
                    win_1 = ((win_1 << 1) | u32::from(img.get_pixel(x + w.right_1, y - 1))) & w.mask_1;
                    win_2 = ((win_2 << 1) | u32::from(img.get_pixel(x + w.right_2, y - 2))) & w.mask_2;
                    (left | (win_1 << w.shift_1) | (win_2 << w.shift_2)) as usize
                } else {
                    self.context(&img, x, y)
                };
                let bit = if self.skip.is_some_and(|skip| skip.get_pixel(x, y) == 1) {
                    0
                } else {
                    if decoder.is_complete() {
                        if fast {
                            // the byte under construction is not stored
                            for px in (x & !7)..x {
                                img.set_pixel(px, y, 0);
                            }
                        }
                        return Some(Decoded { image: img, rows: y });
                    }
                    decoder.decode(&mut cx[context])
                };
                if bit == 1 {
                    img.set_pixel(x, y, 1);
                }
                left = ((left << 1) | u32::from(bit)) & w.left_mask;
            }
        }
        Some(Decoded {
            image: img,
            rows: self.height,
        })
    }

    /// Decodes the region as MMR (T.6) data starting at bit `start_bit` of `src`; returns the image and the bit
    /// position after the data. `None` when the region's size is not one the decoder allocates.
    pub fn decode_mmr(&self, src: &[u8], start_bit: usize) -> Option<(Image, usize)> {
        let mut img = Image::new(self.width, self.height)?;
        let stride = img.stride();
        let bit_pos = ccitt::g4_decode(src, start_bit, self.width, self.height, stride, img.data_mut());
        for byte in img.data_mut() {
            *byte = !*byte;
        }
        Some((img, bit_pos))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn region(width: i32, height: i32) -> GenericRegion<'static> {
        GenericRegion {
            width,
            height,
            template: 0,
            tpgdon: false,
            skip: None,
            at: [3, -1, -3, -1, 2, -2, -2, -2],
        }
    }

    #[test]
    fn context_counts() {
        assert_eq!(context_count(0), 65536);
        assert_eq!(context_count(1), 8192);
        assert_eq!(context_count(2), 1024);
        assert_eq!(context_count(3), 1024);
    }

    #[test]
    fn default_pixels_are_recognised() {
        assert!(region(8, 8).default_pixels());
        let mut moved = region(8, 8);
        moved.at[0] = 4;
        assert!(!moved.default_pixels());
        let mut t1 = region(8, 8);
        t1.template = 1;
        assert!(t1.default_pixels());
        t1.at[1] = -2;
        assert!(!t1.default_pixels());
        let skip = Image::new(8, 8).unwrap();
        let mut skipping = region(8, 8);
        skipping.skip = Some(&skip);
        assert!(!skipping.default_pixels());
    }

    /// The sliding windows of the standard adaptive pixels give the context the pixel-by-pixel formula gives.
    #[test]
    fn windows_agree_with_the_formula() {
        let mut img = Image::new(24, 6).unwrap();
        let mut seed = 0x1234_5678u32;
        for y in 0..6 {
            for x in 0..24 {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                img.set_pixel(x, y, u8::from(seed >> 28 > 6));
            }
        }
        for template in 0..4u8 {
            let mut region = region(24, 6);
            region.template = template;
            region.at = match template {
                0 => [3, -1, -3, -1, 2, -2, -2, -2],
                1 => [3, -1, 0, 0, 0, 0, 0, 0],
                _ => [2, -1, 0, 0, 0, 0, 0, 0],
            };
            let w = &WINDOWS[usize::from(template)];
            let y = 4;
            let (mut win_1, mut win_2) = (0u32, 0u32);
            for i in 0..w.right_1 {
                win_1 = (win_1 << 1) | u32::from(img.get_pixel(i, y - 1));
            }
            for i in 0..w.right_2 {
                win_2 = (win_2 << 1) | u32::from(img.get_pixel(i, y - 2));
            }
            let mut left = 0u32;
            for x in 0..24 {
                win_1 = ((win_1 << 1) | u32::from(img.get_pixel(x + w.right_1, y - 1))) & w.mask_1;
                win_2 = ((win_2 << 1) | u32::from(img.get_pixel(x + w.right_2, y - 2))) & w.mask_2;
                let fast = (left | (win_1 << w.shift_1) | (win_2 << w.shift_2)) as usize;
                assert_eq!(fast, region.context(&img, x, y), "template {template} x {x}");
                left = ((left << 1) | u32::from(img.get_pixel(x, y))) & w.left_mask;
            }
        }
    }

    #[test]
    fn mmr_decodes_and_inverts_to_black_ones() {
        // two rows of 8 pixels: all white (V0), then a black run of 3 at x=2 (horizontal mode: white 2, black 3)
        // row 1: 001 (horizontal) 0111 (white 2) 10 (black 3) then V0 to the end
        let src = [0b1001_0111, 0b1010_0000];
        let (img, bits) = region(8, 2).decode_mmr(&src, 0).unwrap();
        assert_eq!(img.get_pixel(0, 0), 0);
        assert_eq!((2..5).map(|x| img.get_pixel(x, 1)).collect::<Vec<_>>(), [1, 1, 1]);
        assert_eq!(img.get_pixel(5, 1), 0);
        assert!(bits >= 8);
        assert!(region(0, 2).decode_mmr(&src, 0).is_none());
    }
}
