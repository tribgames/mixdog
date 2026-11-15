//! Generic refinement region decoding (T.88 6.3): a bitmap coded against a reference bitmap with template 0 or 1 and
//! typical prediction. Like PDFium's decoder it never stops at the end of the data: what is missing decodes from the
//! marker's 1 bits.

use super::image::Image;
use crate::codec::arith::{ArithCx, ArithDecoder};

/// A refinement region's parameters (PDFium's `CJBig2_GRRDProc`).
pub struct RefinementRegion<'a> {
    pub width: i32,
    pub height: i32,
    /// 0 or 1.
    pub template: u8,
    /// Typical prediction (TPGRON).
    pub tpgron: bool,
    /// The bitmap refined: pixel (x, y) of the region is predicted from (x - `dx`, y - `dy`) of it.
    pub reference: &'a Image,
    pub dx: i32,
    pub dy: i32,
    /// The adaptive pixels of template 0: one in the region (offset x, y), one in the reference.
    pub at: [i8; 4],
}

/// The number of contexts a refinement region of `template` uses.
pub fn context_count(template: u8) -> usize {
    if template == 0 { 1 << 13 } else { 1 << 10 }
}

impl RefinementRegion<'_> {
    /// The decoder reads the reference a byte at a time, padding bits included, when the template's pixels are at their
    /// standard places, the reference is not shifted and it is as wide as the region.
    fn reads_padding(&self) -> bool {
        self.dx == 0 && self.width == self.reference.width() && (self.template == 1 || self.at == [-1, -1, -1, -1])
    }

    /// The context of pixel (`x`, `y`) of `img` (T.88 figures 12 and 13).
    fn context(&self, img: &Image, x: i32, y: i32) -> usize {
        let padding = self.reads_padding();
        let p = |ox: i32, oy: i32| usize::from(img.get_pixel(x + ox, y + oy));
        let r = |ox: i32, oy: i32| {
            let (rx, ry) = (
                x.wrapping_sub(self.dx).wrapping_add(ox),
                y.wrapping_sub(self.dy).wrapping_add(oy),
            );
            usize::from(if padding {
                self.reference.padded_pixel(rx, ry)
            } else {
                self.reference.get_pixel(rx, ry)
            })
        };
        if self.template == 0 {
            r(1, 1)
                | (r(0, 1) << 1)
                | (r(-1, 1) << 2)
                | (r(1, 0) << 3)
                | (r(0, 0) << 4)
                | (r(-1, 0) << 5)
                | (r(1, -1) << 6)
                | (r(0, -1) << 7)
                | (r(i32::from(self.at[2]), i32::from(self.at[3])) << 8)
                | (p(-1, 0) << 9)
                | (p(1, -1) << 10)
                | (p(0, -1) << 11)
                | (p(i32::from(self.at[0]), i32::from(self.at[1])) << 12)
        } else {
            r(1, 1)
                | (r(0, 1) << 1)
                | (r(1, 0) << 2)
                | (r(0, 0) << 3)
                | (r(-1, 0) << 4)
                | (r(0, -1) << 5)
                | (p(-1, 0) << 6)
                | (p(1, -1) << 7)
                | (p(0, -1) << 8)
                | (p(-1, -1) << 9)
        }
    }

    /// The value all nine reference pixels around (`x`, `y`) share, if they do.
    fn uniform_reference(&self, x: i32, y: i32) -> Option<u8> {
        let (rx, ry) = (x.wrapping_sub(self.dx), y.wrapping_sub(self.dy));
        let value = self.reference.get_pixel(rx, ry);
        for oy in -1..=1i32 {
            for ox in -1..=1i32 {
                if self.reference.get_pixel(rx.wrapping_add(ox), ry.wrapping_add(oy)) != value {
                    return None;
                }
            }
        }
        Some(value)
    }

    /// Decodes the region with the context table `cx` (`context_count(template)` entries). `None` when the region's
    /// size is not one the decoder allocates.
    pub fn decode(&self, decoder: &mut ArithDecoder, cx: &mut [ArithCx]) -> Option<Image> {
        if !Image::is_valid_region_size(self.width, self.height) {
            return None;
        }
        let mut img = Image::new(self.width, self.height)?;
        let ltp_context = if self.template == 0 { 0x0010 } else { 0x0008 };
        let mut ltp = 0u8;
        for y in 0..self.height {
            if self.tpgron {
                ltp ^= decoder.decode(&mut cx[ltp_context]);
            }
            for x in 0..self.width {
                let bit = match (ltp == 1).then(|| self.uniform_reference(x, y)).flatten() {
                    Some(value) => value,
                    None => {
                        let context = self.context(&img, x, y);
                        decoder.decode(&mut cx[context])
                    }
                };
                if bit == 1 {
                    img.set_pixel(x, y, 1);
                }
            }
        }
        Some(img)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_counts() {
        assert_eq!(context_count(0), 8192);
        assert_eq!(context_count(1), 1024);
    }

    #[test]
    fn the_typical_context_is_the_centre_reference_pixel() {
        let mut reference = Image::new(5, 5).unwrap();
        reference.set_pixel(2, 2, 1);
        let img = Image::new(5, 5).unwrap();
        for (template, expected) in [(0u8, 0x0010usize), (1, 0x0008)] {
            let region = RefinementRegion {
                width: 5,
                height: 5,
                template,
                tpgron: true,
                reference: &reference,
                dx: 0,
                dy: 0,
                at: [-1, -1, -1, -1],
            };
            assert_eq!(region.context(&img, 2, 2), expected);
        }
    }

    #[test]
    fn uniform_neighbourhoods() {
        let mut reference = Image::new(6, 6).unwrap();
        reference.set_pixel(3, 3, 1);
        let region = RefinementRegion {
            width: 6,
            height: 6,
            template: 0,
            tpgron: true,
            reference: &reference,
            dx: 0,
            dy: 0,
            at: [-1, -1, -1, -1],
        };
        assert_eq!(region.uniform_reference(0, 0), Some(0));
        assert_eq!(region.uniform_reference(2, 2), None);
        assert_eq!(region.uniform_reference(5, 5), Some(0));
    }
}
