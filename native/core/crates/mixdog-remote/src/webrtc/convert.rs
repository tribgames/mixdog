//! Frame → I420 conversion for the encoder (BT.601 limited range, the matrix a VP8 receiver
//! assumes). Buffers are reused across frames so the steady state allocates nothing.

use mixdog_core_api::domain::media::MediaError;
use mixdog_core_api::domain::media::PixelFormat;
use mixdog_core_api::domain::media::VideoFrame;

/// The live view's pixel bound.
pub const MAX_DIMENSION: u32 = 8_192;

#[derive(Default)]
pub struct I420Buf {
    pub width: usize,
    pub height: usize,
    pub y: Vec<u8>,
    pub u: Vec<u8>,
    pub v: Vec<u8>,
}

/// Where red, green and blue sit inside one source pixel.
struct Layout {
    bytes_per_pixel: usize,
    r: usize,
    g: usize,
    b: usize,
}

const BGR_X: Layout = Layout {
    bytes_per_pixel: 4,
    r: 2,
    g: 1,
    b: 0,
};
const RGB: Layout = Layout {
    bytes_per_pixel: 3,
    r: 0,
    g: 1,
    b: 2,
};
const GRAY: Layout = Layout {
    bytes_per_pixel: 1,
    r: 0,
    g: 0,
    b: 0,
};

fn invalid(reason: impl Into<String>) -> MediaError {
    MediaError::InvalidFrame {
        reason: reason.into(),
    }
}

impl I420Buf {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fills the buffer from `frame`, sized to the frame.
    pub fn fill(&mut self, frame: &VideoFrame) -> Result<(), MediaError> {
        if frame.width == 0
            || frame.height == 0
            || frame.width > MAX_DIMENSION
            || frame.height > MAX_DIMENSION
        {
            return Err(invalid("frame size out of bounds"));
        }
        let (width, height) = (frame.width as usize, frame.height as usize);
        match frame.format {
            PixelFormat::Bgra | PixelFormat::Bgrx => {
                let stride = frame.stride as usize;
                if stride < width * BGR_X.bytes_per_pixel {
                    return Err(invalid("stride shorter than a row"));
                }
                self.check_len(frame)?;
                self.from_packed(&frame.data, stride, width, height, &BGR_X);
            }
            PixelFormat::I420 => {
                self.check_len(frame)?;
                self.resize(width, height);
                let (y_len, c_len) = (width * height, width.div_ceil(2) * height.div_ceil(2));
                self.y.copy_from_slice(&frame.data[..y_len]);
                self.u.copy_from_slice(&frame.data[y_len..y_len + c_len]);
                self.v.copy_from_slice(&frame.data[y_len + c_len..y_len + 2 * c_len]);
            }
            PixelFormat::Jpeg => self.from_jpeg(&frame.data)?,
        }
        Ok(())
    }

    fn check_len(&self, frame: &VideoFrame) -> Result<(), MediaError> {
        match frame.required_len() {
            Some(len) if frame.data.len() >= len => Ok(()),
            Some(_) => Err(invalid("frame data shorter than its geometry")),
            None => Ok(()),
        }
    }

    fn resize(&mut self, width: usize, height: usize) {
        self.width = width;
        self.height = height;
        let chroma = width.div_ceil(2) * height.div_ceil(2);
        self.y.resize(width * height, 0);
        self.u.resize(chroma, 0);
        self.v.resize(chroma, 0);
    }

    fn from_jpeg(&mut self, data: &[u8]) -> Result<(), MediaError> {
        let mut decoder = jpeg_decoder::Decoder::new(data);
        let pixels = decoder
            .decode()
            .map_err(|e| invalid(format!("jpeg: {e}")))?;
        let info = decoder.info().ok_or_else(|| invalid("jpeg: no header"))?;
        let (width, height) = (usize::from(info.width), usize::from(info.height));
        if width == 0 || height == 0 {
            return Err(invalid("jpeg: empty picture"));
        }
        let layout = match info.pixel_format {
            jpeg_decoder::PixelFormat::RGB24 => &RGB,
            jpeg_decoder::PixelFormat::L8 => &GRAY,
            other => return Err(invalid(format!("jpeg pixel format {other:?}"))),
        };
        self.from_packed(&pixels, width * layout.bytes_per_pixel, width, height, layout);
        Ok(())
    }

    fn from_packed(&mut self, src: &[u8], stride: usize, width: usize, height: usize, layout: &Layout) {
        self.resize(width, height);
        let chroma_width = width.div_ceil(2);
        let pixel = |x: usize, y: usize| -> (i32, i32, i32) {
            let at = y * stride + x * layout.bytes_per_pixel;
            (
                i32::from(src[at + layout.r]),
                i32::from(src[at + layout.g]),
                i32::from(src[at + layout.b]),
            )
        };
        for row in 0..height {
            for col in 0..width {
                let (r, g, b) = pixel(col, row);
                self.y[row * width + col] = (((66 * r + 129 * g + 25 * b + 128) >> 8) + 16) as u8;
            }
        }
        for crow in 0..height.div_ceil(2) {
            for ccol in 0..chroma_width {
                let (mut r, mut g, mut b, mut n) = (0, 0, 0, 0);
                for dy in 0..2 {
                    for dx in 0..2 {
                        let (x, y) = (ccol * 2 + dx, crow * 2 + dy);
                        if x < width && y < height {
                            let (pr, pg, pb) = pixel(x, y);
                            r += pr;
                            g += pg;
                            b += pb;
                            n += 1;
                        }
                    }
                }
                let (r, g, b) = (r / n, g / n, b / n);
                let at = crow * chroma_width + ccol;
                self.u[at] = (((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128) as u8;
                self.v[at] = (((112 * r - 94 * g - 18 * b + 128) >> 8) + 128) as u8;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use bytes::Bytes;

    use super::*;

    fn frame(format: PixelFormat, width: u32, height: u32, stride: u32, data: Vec<u8>) -> VideoFrame {
        VideoFrame {
            width,
            height,
            stride,
            format,
            data: Bytes::from(data),
            seq: 0,
            captured_at: Duration::ZERO,
        }
    }

    #[test]
    fn bgrx_primaries_follow_bt601() {
        // Two pixels per row: pure white then pure black, BGRX with a padded stride.
        let row = [255, 255, 255, 0, 0, 0, 0, 0, 9, 9, 9, 9];
        let mut data = Vec::new();
        data.extend_from_slice(&row);
        data.extend_from_slice(&row);
        let mut buf = I420Buf::new();
        buf.fill(&frame(PixelFormat::Bgrx, 2, 2, 12, data)).unwrap();
        assert_eq!(buf.y, vec![235, 16, 235, 16]);
        // One chroma sample: the average of white and black is mid grey, neutral chroma.
        assert_eq!((buf.u[0], buf.v[0]), (128, 128));
    }

    #[test]
    fn odd_sizes_round_chroma_up() {
        let data = vec![255u8; 3 * 3 * 4];
        let mut buf = I420Buf::new();
        buf.fill(&frame(PixelFormat::Bgra, 3, 3, 12, data)).unwrap();
        assert_eq!((buf.y.len(), buf.u.len(), buf.v.len()), (9, 4, 4));
    }

    #[test]
    fn i420_passes_through() {
        let data: Vec<u8> = (0..(4 * 4 + 2 * 4)).map(|n| n as u8).collect();
        let mut buf = I420Buf::new();
        buf.fill(&frame(PixelFormat::I420, 4, 4, 4, data.clone())).unwrap();
        assert_eq!(buf.y, &data[..16]);
        assert_eq!(buf.u, &data[16..20]);
        assert_eq!(buf.v, &data[20..24]);
    }

    #[test]
    fn short_or_oversized_frames_are_refused() {
        let mut buf = I420Buf::new();
        assert!(buf.fill(&frame(PixelFormat::Bgra, 4, 4, 16, vec![0; 10])).is_err());
        assert!(buf.fill(&frame(PixelFormat::Bgra, 4, 4, 8, vec![0; 64])).is_err());
        assert!(buf.fill(&frame(PixelFormat::Bgra, 0, 4, 0, vec![])).is_err());
        assert!(buf.fill(&frame(PixelFormat::Jpeg, 0, 0, 0, vec![1, 2, 3])).is_err());
    }
}
