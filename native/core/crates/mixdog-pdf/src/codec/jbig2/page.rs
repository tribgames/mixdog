//! The page of a JBIG2 stream (T.88 7.4.8): the buffer the regions are composed onto, filled with the default pixel by
//! the page information segment, and its delivery as the image the PDF filter produces.

use super::BitStream;
use super::image::{ComposeOp, Image};
use std::ops::Range;

/// The page buffer. It has the size of the PDF image (the page information segment's own size is not used) and its
/// bytes start as 0 (white).
pub struct Page {
    image: Image,
}

/// What the page information segment (type 48) says that matters here.
pub struct PageInfo {
    pub width: u32,
    pub height: u32,
    /// The page is filled with black rather than white.
    pub default_black: bool,
    /// The height a striped page is allocated with when its own height is unknown (0xFFFFFFFF).
    pub max_stripe_height: u16,
}

impl PageInfo {
    /// Reads the segment data: width, height, resolutions, flags, striping.
    pub fn read(stream: &mut BitStream) -> Option<PageInfo> {
        let width = stream.read_u32()?;
        let height = stream.read_u32()?;
        stream.read_u32()?;
        stream.read_u32()?;
        let flags = stream.read_u8()?;
        let striping = stream.read_u16()?;
        Some(PageInfo {
            width,
            height,
            default_black: flags & 4 != 0,
            max_stripe_height: striping & 0x7fff,
        })
    }

    /// The bitmap a page without a given buffer is allocated as: a page whose size the decoder cannot allocate fails.
    pub fn can_allocate(&self) -> bool {
        let height = if self.height == u32::MAX {
            u32::from(self.max_stripe_height)
        } else {
            self.height
        };
        i32::try_from(self.width).is_ok_and(|w| i32::try_from(height).is_ok_and(|h| Image::new(w, h).is_some()))
    }
}

impl Page {
    /// A white page of the PDF image's size; `None` when the decoder could not allocate it.
    pub fn new(width: i32, height: i32) -> Option<Page> {
        Some(Page {
            image: Image::new(width, height)?,
        })
    }

    /// The page information's default pixel.
    pub fn fill(&mut self, black: bool) {
        self.image.fill(black);
    }

    pub fn image(&self) -> &Image {
        &self.image
    }

    /// Composes the rows `rows` of a decoded region onto the page at (`x`, `y`).
    pub fn compose(&mut self, region: &Image, x: i32, y: i32, op: ComposeOp, rows: Range<i32>) {
        region.compose_rows_to(&mut self.image, x, y, op, rows);
    }

    /// The image the filter delivers: 0 = black, `(width + 7) / 8` bytes per row (the padding bits of a row come out
    /// as the page holds them, inverted).
    pub fn into_output(self) -> Vec<u8> {
        let width = self.image.width() as usize;
        let stride = self.image.stride();
        let pitch = width.div_ceil(8);
        let mut out = Vec::with_capacity(pitch * self.image.height() as usize);
        for row in self.image.data().chunks_exact(stride) {
            out.extend(row[..pitch].iter().map(|b| !b));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_is_inverted_and_cropped_to_the_pitch() {
        let mut page = Page::new(12, 2).unwrap();
        let mut region = Image::new(4, 1).unwrap();
        region.fill(true);
        page.compose(&region, 0, 1, ComposeOp::Or, 0..1);
        // row 0 white, row 1 black in its first four pixels; 12 pixels need 2 bytes per row
        assert_eq!(page.into_output(), [0xff, 0xff, 0x0f, 0xff]);
        let mut black = Page::new(12, 1).unwrap();
        black.fill(true);
        assert_eq!(black.into_output(), [0x00, 0x00]);
    }

    #[test]
    fn page_sizes_are_bounded_like_images() {
        assert!(Page::new(65536, 1).is_some());
        assert!(Page::new(70000, 2).is_some());
        assert!(Page::new(100_000, 100_000).is_none());
        assert!(Page::new(8192, 262143).is_some());
        assert!(Page::new(8192, 262144).is_none());
        assert!(Page::new(0, 5).is_none());
    }

    #[test]
    fn page_info_reads_the_default_pixel_and_stripe() {
        let mut data = vec![];
        data.extend_from_slice(&8u32.to_be_bytes());
        data.extend_from_slice(&u32::MAX.to_be_bytes());
        data.extend_from_slice(&[0; 8]);
        data.push(4);
        data.extend_from_slice(&0x8010u16.to_be_bytes());
        let mut stream = BitStream::new(&data);
        let info = PageInfo::read(&mut stream).unwrap();
        assert_eq!(
            (info.width, info.height, info.default_black, info.max_stripe_height),
            (8, u32::MAX, true, 16)
        );
        assert!(info.can_allocate());
        let mut short = BitStream::new(&data[..10]);
        assert!(PageInfo::read(&mut short).is_none());
    }
}
