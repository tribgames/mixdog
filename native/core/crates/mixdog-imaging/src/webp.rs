//! Lossy WebP encoding through libwebp, the encoder libvips (and so sharp) writes WebP with: the same format, the same
//! 0 to 100 quality scale and the same alpha handling.
//!
//! sharp's `webp({ quality })` is libwebp's default preset at that quality with the effort (`method`) at 4 and the
//! alpha at full quality (`alpha_quality` 100); the alpha channel is written when the picture has one, and no
//! metadata is.

use std::ffi::c_int;
use std::ffi::c_void;

use libwebp_sys::WebPConfig;
use libwebp_sys::WebPEncode;
use libwebp_sys::WebPMemoryWrite;
use libwebp_sys::WebPMemoryWriter;
use libwebp_sys::WebPMemoryWriterClear;
use libwebp_sys::WebPMemoryWriterInit;
use libwebp_sys::WebPPicture;
use libwebp_sys::WebPPictureFree;
use libwebp_sys::WebPPictureImportRGB;
use libwebp_sys::WebPPictureImportRGBA;
use libwebp_sys::WebPPreset;
use libwebp_sys::WebPValidateConfig;

use crate::decode::Raster;
use crate::error::ImagingError;

/// libwebp's limit on either side of a picture (`WEBP_MAX_DIMENSION`).
pub const MAX_DIMENSION: u32 = 16383;

/// sharp's `effort` default.
const EFFORT: c_int = 4;

fn failure(what: &str) -> ImagingError {
    ImagingError::environment(format!("lossy WebP encoding failed: {what}"))
}

/// A picture that frees what libwebp allocated for it.
struct Picture(WebPPicture);

impl Drop for Picture {
    fn drop(&mut self) {
        // SAFETY: the picture was initialised by `WebPPicture::new`; freeing one that holds no memory is a no-op.
        unsafe { WebPPictureFree(&mut self.0) };
    }
}

/// libwebp's growing output buffer, released when it goes out of scope.
struct Output(WebPMemoryWriter);

impl Output {
    fn new() -> Self {
        let mut writer = WebPMemoryWriter { mem: std::ptr::null_mut(), size: 0, max_size: 0, pad: [0] };
        // SAFETY: `writer` is a valid, writable `WebPMemoryWriter`.
        unsafe { WebPMemoryWriterInit(&mut writer) };
        Self(writer)
    }

    fn bytes(&self) -> Vec<u8> {
        if self.0.mem.is_null() {
            return Vec::new();
        }
        // SAFETY: after a successful encode `mem` points at `size` initialised bytes that `WebPMemoryWrite` owns.
        unsafe { std::slice::from_raw_parts(self.0.mem, self.0.size) }.to_vec()
    }
}

impl Drop for Output {
    fn drop(&mut self) {
        // SAFETY: the writer was initialised by `WebPMemoryWriterInit`; clearing frees its buffer.
        unsafe { WebPMemoryWriterClear(&mut self.0) };
    }
}

/// Encodes `raster` as lossy WebP at `quality` (1 to 100, as sharp's). The alpha channel is kept when the raster has
/// one.
pub fn encode_lossy(raster: &Raster, quality: u8) -> Result<Vec<u8>, ImagingError> {
    if raster.width == 0 || raster.height == 0 || raster.width > MAX_DIMENSION || raster.height > MAX_DIMENSION {
        return Err(failure("Processed image is too large for the WebP format"));
    }
    if raster.data.len() != raster.width as usize * raster.height as usize * raster.channels() {
        return Err(failure("the pixel buffer does not match the size"));
    }
    let mut config = WebPConfig::new_with_preset(WebPPreset::WEBP_PRESET_DEFAULT, f32::from(quality.clamp(1, 100)))
        .map_err(|()| failure("the encoder library does not match its headers"))?;
    config.method = EFFORT;
    config.alpha_quality = 100;
    // SAFETY: `config` is fully initialised.
    if unsafe { WebPValidateConfig(&config) } == 0 {
        return Err(failure("the encoder settings were refused"));
    }

    let mut picture = Picture(WebPPicture::new().map_err(|()| failure("the encoder library does not match its headers"))?);
    picture.0.use_argb = 0;
    picture.0.width = raster.width as c_int;
    picture.0.height = raster.height as c_int;
    let stride = (raster.width as usize * raster.channels()) as c_int;
    // SAFETY: the width and height are set and `data` holds `height` rows of `stride` bytes (checked above); the
    // import copies the pixels and allocates the picture's own planes.
    let imported = unsafe {
        if raster.has_alpha {
            WebPPictureImportRGBA(&mut picture.0, raster.data.as_ptr(), stride)
        } else {
            WebPPictureImportRGB(&mut picture.0, raster.data.as_ptr(), stride)
        }
    };
    if imported == 0 {
        return Err(failure("out of memory"));
    }

    let mut output = Output::new();
    picture.0.writer = Some(WebPMemoryWrite);
    picture.0.custom_ptr = std::ptr::addr_of_mut!(output.0).cast::<c_void>();
    // SAFETY: the picture holds its planes and a writer whose target `output` outlives the call.
    let encoded = unsafe { WebPEncode(&config, &mut picture.0) };
    if encoded == 0 {
        return Err(failure(&format!("{:?}", picture.0.error_code)));
    }
    Ok(output.bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::DECODE_PIXEL_LIMIT;
    use crate::decode::Format;
    use crate::decode::decode;

    fn gradient(width: u32, height: u32, has_alpha: bool) -> Raster {
        let mut data = Vec::new();
        for y in 0..height {
            for x in 0..width {
                data.extend_from_slice(&[(x * 255 / width) as u8, (y * 255 / height) as u8, 90]);
                if has_alpha {
                    data.push(if x < width / 2 { 255 } else { 64 });
                }
            }
        }
        Raster { width, height, has_alpha, data }
    }

    fn mean_error(a: &[u8], b: &[u8]) -> f64 {
        a.iter().zip(b).map(|(x, y)| f64::from(x.abs_diff(*y))).sum::<f64>() / a.len() as f64
    }

    #[test]
    fn an_opaque_picture_is_a_lossy_webp_of_its_size_close_to_the_original() {
        let raster = gradient(64, 48, false);
        let webp = encode_lossy(&raster, 80).unwrap();
        assert_eq!(&webp[..4], b"RIFF");
        assert_eq!(&webp[8..12], b"WEBP");
        assert_eq!(&webp[12..16], b"VP8 ", "lossy, no alpha chunk");
        let back = decode(&webp, DECODE_PIXEL_LIMIT).unwrap();
        assert_eq!((back.format, back.width, back.height, back.raster.has_alpha), (Format::Webp, 64, 48, false));
        assert!(mean_error(&back.raster.data, &raster.data) <= 6.0);
    }

    #[test]
    fn the_alpha_channel_is_kept_when_there_is_one() {
        let raster = gradient(40, 40, true);
        let webp = encode_lossy(&raster, 80).unwrap();
        assert_eq!(&webp[12..16], b"VP8X", "the extended header that carries alpha");
        let back = decode(&webp, DECODE_PIXEL_LIMIT).unwrap();
        assert!(back.raster.has_alpha);
        let rgba = back.raster.to_rgba();
        assert_eq!(rgba[3], 255, "the opaque half stays opaque");
        assert_eq!(rgba[39 * 4 + 3], 64, "the translucent half keeps its level (alpha is written at full quality)");
    }

    #[test]
    fn a_higher_quality_costs_more_bytes() {
        let mut state = 7u32;
        let mut raster = gradient(96, 96, false);
        for byte in &mut raster.data {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            *byte = byte.wrapping_add((state >> 28) as u8);
        }
        let low = encode_lossy(&raster, 20).unwrap().len();
        let high = encode_lossy(&raster, 95).unwrap().len();
        assert!(high > low, "{high} bytes at 95, {low} at 20");
    }

    #[test]
    fn a_picture_libwebp_cannot_hold_is_refused() {
        let too_wide = Raster { width: MAX_DIMENSION + 1, height: 1, has_alpha: false, data: vec![0; (MAX_DIMENSION as usize + 1) * 3] };
        assert!(encode_lossy(&too_wide, 80).unwrap_err().is_environment());
        let torn = Raster { width: 4, height: 4, has_alpha: false, data: vec![0; 5] };
        assert!(encode_lossy(&torn, 80).is_err());
    }

    #[test]
    fn a_single_pixel_encodes() {
        let one = Raster { width: 1, height: 1, has_alpha: false, data: vec![200, 100, 50] };
        let back = decode(&encode_lossy(&one, 70).unwrap(), DECODE_PIXEL_LIMIT).unwrap();
        assert_eq!((back.width, back.height), (1, 1));
    }
}
