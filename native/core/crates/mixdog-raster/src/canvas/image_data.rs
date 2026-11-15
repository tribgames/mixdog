//! Pixels in and out of a canvas: [`Bitmap`] (what `drawImage` and patterns read: premultiplied pixels, as a decoded
//! image is held by Skia) and [`ImageData`] (what `getImageData` and `putImageData` exchange: straight RGBA8).
//!
//! The conversions round as Skia does. Premultiplying (decoding an image, `putImageData`) is `SkMulDiv255Round`,
//! `(c * a + 128 + ((c * a + 128) >> 8)) >> 8`. Unpremultiplying (`getImageData`) is the raster pipeline's: the colour
//! scaled by the reciprocal of the alpha in `f32`, rounded to the nearest byte.

use tiny_skia::IntSize;
use tiny_skia::Pixmap;

use super::Canvas;
use crate::Image;
use crate::RasterError;

/// `SkMulDiv255Round(c, a)`.
pub(crate) fn premultiply(channel: u8, alpha: u8) -> u8 {
    let product = u32::from(channel) * u32::from(alpha) + 128;
    ((product + (product >> 8)) >> 8) as u8
}

/// The straight colour of a premultiplied channel.
pub(crate) fn unpremultiply(channel: u8, alpha: u8) -> u8 {
    if alpha == 0 {
        return 0;
    }
    if alpha == 255 {
        return channel;
    }
    let scale = 1.0 / (f32::from(alpha) / 255.0);
    (f32::from(channel) / 255.0 * scale * 255.0 + 0.5).clamp(0.0, 255.0) as u8
}

/// An image to draw: premultiplied RGBA8 pixels.
#[derive(Clone, Debug)]
pub struct Bitmap {
    pixmap: Pixmap,
}

impl Bitmap {
    /// A decoded picture (`loadImage`), premultiplied.
    pub fn from_image(image: &Image) -> Result<Self, RasterError> {
        Self::from_straight(image.width(), image.height(), image.rgba())
    }

    /// Straight RGBA8 pixels, premultiplied.
    pub fn from_straight(width: u32, height: u32, rgba: &[u8]) -> Result<Self, RasterError> {
        let size = IntSize::from_wh(width, height).ok_or_else(|| RasterError::new("an image has no pixels"))?;
        if rgba.len() != width as usize * height as usize * 4 {
            return Err(RasterError::new("the pixel data does not match the size of the image"));
        }
        let mut data = Vec::with_capacity(rgba.len());
        for pixel in rgba.chunks_exact(4) {
            let alpha = pixel[3];
            data.extend_from_slice(&[premultiply(pixel[0], alpha), premultiply(pixel[1], alpha), premultiply(pixel[2], alpha), alpha]);
        }
        let pixmap = Pixmap::from_vec(data, size).ok_or_else(|| RasterError::new("the image is too large"))?;
        Ok(Self { pixmap })
    }

    /// A copy of what a canvas shows now (a canvas is a valid `drawImage` source).
    pub fn from_canvas(canvas: &Canvas) -> Self {
        Self { pixmap: canvas.pixmap().clone() }
    }

    pub fn width(&self) -> u32 {
        self.pixmap.width()
    }

    pub fn height(&self) -> u32 {
        self.pixmap.height()
    }

    pub(crate) fn pixmap(&self) -> &Pixmap {
        &self.pixmap
    }
}

/// `ImageData`: `width * height` straight RGBA8 pixels.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImageData {
    width: u32,
    height: u32,
    data: Vec<u8>,
}

impl ImageData {
    /// Transparent black.
    pub fn new(width: u32, height: u32) -> Result<Self, RasterError> {
        if width == 0 || height == 0 {
            return Err(RasterError::new("an ImageData needs a width and a height above zero"));
        }
        let len = (width as usize).checked_mul(height as usize).and_then(|n| n.checked_mul(4)).ok_or_else(|| RasterError::new("the ImageData is too large"))?;
        Ok(Self { width, height, data: vec![0; len] })
    }

    pub fn from_rgba(width: u32, height: u32, data: Vec<u8>) -> Result<Self, RasterError> {
        if width == 0 || height == 0 || data.len() != width as usize * height as usize * 4 {
            return Err(RasterError::new("the pixel data does not match the size of the ImageData"));
        }
        Ok(Self { width, height, data })
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn data(&self) -> &[u8] {
        &self.data
    }

    pub fn data_mut(&mut self) -> &mut [u8] {
        &mut self.data
    }

    pub fn into_data(self) -> Vec<u8> {
        self.data
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn premultiplying_rounds_like_skia() {
        assert_eq!(premultiply(255, 255), 255);
        assert_eq!(premultiply(255, 128), 128);
        assert_eq!(premultiply(200, 0), 0);
        assert_eq!(premultiply(100, 51), 20);
        assert_eq!(premultiply(1, 128), 1);
    }

    #[test]
    fn unpremultiplying_inverts_it_within_a_step() {
        assert_eq!(unpremultiply(0, 0), 0);
        assert_eq!(unpremultiply(77, 255), 77);
        assert_eq!(unpremultiply(128, 128), 255);
        assert_eq!(unpremultiply(32, 128), 64);
        for alpha in [1_u8, 2, 17, 100, 200, 254] {
            for channel in [0_u8, 3, 90, 180, 255] {
                let stored = premultiply(channel, alpha);
                let back = unpremultiply(stored, alpha);
                assert!((i32::from(back) - i32::from(channel)).abs() <= (255 / i32::from(alpha)).max(1), "{channel} at {alpha}: {back}");
            }
        }
    }

    #[test]
    fn a_bitmap_takes_straight_pixels_and_refuses_a_wrong_length() {
        let bitmap = Bitmap::from_straight(1, 1, &[255, 0, 0, 128]).unwrap();
        assert_eq!(bitmap.pixmap().data(), [128, 0, 0, 128]);
        assert!(Bitmap::from_straight(1, 2, &[0; 4]).is_err());
        assert!(Bitmap::from_straight(0, 1, &[]).is_err());
    }

    #[test]
    fn image_data_is_sized() {
        assert_eq!(ImageData::new(2, 3).unwrap().data().len(), 24);
        assert!(ImageData::new(0, 3).is_err());
        assert!(ImageData::from_rgba(1, 1, vec![0; 3]).is_err());
    }
}
