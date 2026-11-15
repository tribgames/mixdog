//! The opacity half of `PDFImage`: `fillOpacity` (the soft mask, the stencil `Mask` image and the colour key
//! `Mask` array), `fillGrayBuffer` (a gray image, resampled to the size of the image it masks, as the alpha
//! channel), and `undoPreblend` (the `Matte` of a soft mask, and the premultiplied alpha of a JPX image).
//!
//! Every write is a `Uint8ClampedArray` store: a write past the end of the buffer is dropped.

use super::decode::{Comps, MaskKind, PdfImage, buffer_length, format_error};
use crate::color::to_u8_clamped;
use crate::error::Result;
use crate::xref::Xref;

/// The options of `fillGrayBuffer`.
#[derive(Debug, Clone, Copy)]
pub(super) struct GrayOptions {
    pub(super) dest_width: Option<usize>,
    pub(super) dest_height: Option<usize>,
    pub(super) invert_output: bool,
    pub(super) max_rows: Option<usize>,
    pub(super) offset: usize,
    pub(super) stride: usize,
}

fn put(buffer: &mut [u8], at: usize, value: i64) {
    if let Some(slot) = buffer.get_mut(at) {
        *slot = value.clamp(0, 255) as u8;
    }
}

/// `PDFImage.#undoPreblend`: the colours of `length` bytes of RGBA pixels divided by their alpha (a transparent pixel
/// becomes white).
pub(super) fn undo_preblend_buffer(buffer: &mut [u8], length: usize, matte: [u8; 3]) {
    let end = length.min(buffer.len());
    let mut i = 0;
    while i + 3 < end {
        let alpha = buffer[i + 3];
        if alpha == 0 {
            buffer[i] = 255;
            buffer[i + 1] = 255;
            buffer[i + 2] = 255;
        } else {
            let k = 255.0 / f64::from(alpha);
            for (c, m) in matte.iter().enumerate() {
                let m = f64::from(*m);
                buffer[i + c] = to_u8_clamped((f64::from(buffer[i + c]) - m) * k + m);
            }
        }
        i += 4;
    }
}

impl PdfImage {
    /// `fillOpacity`: writes the alpha of `width x height` pixels into `rgba` (the first `actual_height` rows).
    /// `image` holds the components before `Decode` is applied.
    pub(super) fn fill_opacity(
        &self,
        xref: &Xref,
        rgba: &mut [u8],
        width: usize,
        height: usize,
        actual_height: usize,
        image: &Comps,
    ) -> Result<()> {
        let options = |invert_output: bool| GrayOptions {
            dest_width: Some(width),
            dest_height: Some(height),
            invert_output,
            max_rows: Some(actual_height),
            offset: 3,
            stride: 4,
        };
        if let Some(smask) = &self.smask {
            return smask.fill_gray_buffer(xref, rgba, options(false));
        }
        match &self.mask {
            MaskKind::Image(mask) => mask.fill_gray_buffer(xref, rgba, options(true)),
            MaskKind::ColourKey(ranges) => {
                for i in 0..width * actual_height {
                    let mut opacity = 0;
                    let image_offset = i * self.num_comps;
                    for j in 0..self.num_comps {
                        let color = image.get(image_offset + j);
                        let low = ranges.get(j * 2).copied().unwrap_or(f64::NAN);
                        let high = ranges.get(j * 2 + 1).copied().unwrap_or(f64::NAN);
                        if color < low || color > high {
                            opacity = 255;
                            break;
                        }
                    }
                    put(rgba, i * 4 + 3, opacity);
                }
                Ok(())
            }
            MaskKind::None => {
                for i in 0..width * actual_height {
                    put(rgba, i * 4 + 3, 255);
                }
                Ok(())
            }
        }
    }

    /// `undoPreblend(buffer, width, height)`: the `Matte` of the soft mask, in this image's colour space.
    pub(super) fn undo_preblend(
        &self,
        buffer: &mut [u8],
        width: usize,
        height: usize,
    ) -> Result<()> {
        let Some(matte) = self.smask.as_ref().and_then(|s| s.matte.as_ref()) else {
            return Ok(());
        };
        let Some(space) = &self.colour_space else {
            return Ok(());
        };
        let rgb = space.get_rgb(matte, 0)?;
        undo_preblend_buffer(buffer, width * height * 4, rgb);
        Ok(())
    }

    /// `fillGrayBuffer`: the gray levels of this image, resampled to the destination size, written into `buffer`.
    pub(super) fn fill_gray_buffer(
        &self,
        xref: &Xref,
        buffer: &mut [u8],
        options: GrayOptions,
    ) -> Result<()> {
        if self.num_comps != 1 {
            return Err(format_error(format!(
                "Reading gray scale from a color image: {}",
                self.num_comps
            )));
        }
        let (src_width, src_height, bpc) = (self.width, self.height, self.bpc);
        let row_bytes =
            ((src_width as u128 * self.num_comps as u128 * u128::from(bpc) + 7) >> 3) as usize;
        let image = self.gray_bytes(xref, buffer_length(&[src_height, row_bytes])?)?;
        let mut comps = self.components(image)?;
        let dest_width = options.dest_width.unwrap_or(src_width);
        let dest_height = options.dest_height.unwrap_or(src_height);
        let needs_resampling = dest_width != src_width || dest_height != src_height;
        let rows = options.max_rows.map_or(dest_height, |m| dest_height.min(m));
        let mut output_width = src_width;
        let mut y_ratio = 0.0;
        let mut x_scaled: Option<Vec<usize>> = None;
        if needs_resampling {
            output_width = dest_width;
            y_ratio = src_height as f64 / dest_height as f64;
            let x_ratio = src_width as f64 / dest_width as f64;
            x_scaled = Some(
                (0..dest_width)
                    .map(|i| (i as f64 * x_ratio).floor() as usize)
                    .collect(),
            );
        }
        let mask: i64 = if options.invert_output { 0xff } else { 0 };
        let (offset, stride) = (options.offset, options.stride);
        if bpc == 1 {
            let needs_decode = self.needs_decode;
            let level = |comps: &Comps, index: usize| -> i64 {
                let c = comps.get(index);
                let bit = if c.is_nan() { 0 } else { c as i64 };
                // `-c & 255` and `c - 1 & 255` (an unreadable sample is NaN, which both read as 0)
                let value = if c.is_nan() {
                    0
                } else if needs_decode {
                    (bit - 1) & 255
                } else {
                    (-bit) & 255
                };
                value ^ mask
            };
            match &x_scaled {
                Some(x_map) => {
                    let mut dest = offset;
                    for row in 0..rows {
                        let py = (row as f64 * y_ratio).floor() as usize * src_width;
                        for col in 0..output_width {
                            put(buffer, dest, level(&comps, py + x_map[col]));
                            dest += stride;
                        }
                    }
                }
                None => {
                    for i in 0..output_width * rows {
                        put(buffer, i * stride + offset, level(&comps, i));
                    }
                }
            }
            return Ok(());
        }
        if self.needs_decode {
            self.decode_buffer(&mut comps);
        }
        let scale = 255.0 / super::decode::max_value(bpc);
        let level = |comps: &Comps, index: usize| -> i64 {
            let value = scale * comps.get(index);
            let integer = if value.is_nan() {
                0
            } else {
                i64::from(value as i64 as i32)
            };
            integer ^ mask
        };
        match &x_scaled {
            Some(x_map) => {
                let mut dest = offset;
                for row in 0..rows {
                    let py = (row as f64 * y_ratio).floor() as usize * src_width;
                    for col in 0..output_width {
                        put(buffer, dest, level(&comps, py + x_map[col]));
                        dest += stride;
                    }
                }
            }
            None => {
                for i in 0..output_width * rows {
                    put(buffer, i * stride + offset, level(&comps, i));
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_transparent_pixel_becomes_white_and_the_matte_is_divided_out() {
        let mut buffer = [10, 20, 30, 0, 100, 100, 100, 128];
        undo_preblend_buffer(&mut buffer, 8, [0, 0, 0]);
        assert_eq!(&buffer[..4], &[255, 255, 255, 0]);
        // 100 * 255 / 128 = 199.2
        assert_eq!(&buffer[4..], &[199, 199, 199, 128]);
    }

    #[test]
    fn the_matte_colour_is_kept_where_the_pixel_is_the_matte() {
        let mut buffer = [50, 50, 50, 64];
        undo_preblend_buffer(&mut buffer, 4, [50, 50, 50]);
        assert_eq!(buffer, [50, 50, 50, 64]);
    }

    #[test]
    fn a_length_past_the_buffer_is_cut_to_the_buffer() {
        let mut buffer = [1, 2, 3, 255];
        undo_preblend_buffer(&mut buffer, 40, [0, 0, 0]);
        assert_eq!(buffer, [1, 2, 3, 255]);
    }

    #[test]
    fn writes_past_the_end_are_dropped_and_values_are_clamped() {
        let mut buffer = [0u8; 2];
        put(&mut buffer, 1, 300);
        put(&mut buffer, 0, -5);
        put(&mut buffer, 2, 9);
        assert_eq!(buffer, [0, 255]);
    }
}
