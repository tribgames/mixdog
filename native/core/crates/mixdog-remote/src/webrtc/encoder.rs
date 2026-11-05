//! The VP8 encoder (libvpx). The core encodes VP8 only (RFC 7742 §5: every WebRTC browser can
//! receive it).

use std::num::NonZeroUsize;

use bytes::Bytes;
use mixdog_core_api::domain::media::MediaError;
use shiguredo_libvpx as vpx;

use super::convert::I420Buf;

/// Lowest target libvpx's rate control is given.
pub const MIN_BITRATE_BPS: u32 = 100_000;
/// Target before any limit or estimate narrows it.
pub const DEFAULT_BITRATE_BPS: u32 = 2_500_000;
/// Cadence libvpx's rate control assumes; the actual pacing is the track's `max_framerate`.
const RATE_CONTROL_FPS: usize = 30;

pub struct EncodedFrame {
    pub data: Bytes,
    pub keyframe: bool,
}

pub struct Vp8Encoder {
    inner: vpx::Encoder,
    width: usize,
    height: usize,
    bitrate_bps: u32,
}

fn encoder_error(context: &str, error: impl std::fmt::Display) -> MediaError {
    MediaError::Encoder {
        detail: format!("{context}: {error}"),
    }
}

impl Vp8Encoder {
    fn build(width: usize, height: usize, bitrate_bps: u32) -> Result<vpx::Encoder, MediaError> {
        let mut config = vpx::EncoderConfig::new(
            width,
            height,
            vpx::ImageFormat::I420,
            vpx::CodecConfig::Vp8(vpx::Vp8Config::default()),
        );
        config.fps_numerator = RATE_CONTROL_FPS;
        config.fps_denominator = 1;
        config.target_bitrate = bitrate_bps as usize;
        config.min_quantizer = 4;
        config.max_quantizer = 56;
        config.deadline = vpx::EncodingDeadline::Realtime;
        config.rate_control = vpx::RateControlMode::Cbr;
        config.cpu_used = Some(8);
        config.threads = NonZeroUsize::new(2);
        // No keyframe timer: keyframes come from requests (new viewer, picture loss, size
        // change); loss is repaired by NACK.
        config.error_resilient = false;
        vpx::Encoder::new(config).map_err(|e| encoder_error("vp8 init", e))
    }

    pub fn new(width: usize, height: usize, bitrate_bps: u32) -> Result<Self, MediaError> {
        let bitrate_bps = bitrate_bps.max(MIN_BITRATE_BPS);
        Ok(Self {
            inner: Self::build(width, height, bitrate_bps)?,
            width,
            height,
            bitrate_bps,
        })
    }

    pub fn fits(&self, width: usize, height: usize) -> bool {
        self.width == width && self.height == height
    }

    pub fn bitrate_bps(&self) -> u32 {
        self.bitrate_bps
    }

    pub fn set_bitrate(&mut self, bitrate_bps: u32) -> Result<(), MediaError> {
        let bitrate_bps = bitrate_bps.max(MIN_BITRATE_BPS);
        if bitrate_bps == self.bitrate_bps {
            return Ok(());
        }
        self.inner
            .reconfigure(&vpx::ReconfigureParams {
                target_bitrate: Some(bitrate_bps as usize),
                ..Default::default()
            })
            .map_err(|e| encoder_error("vp8 bitrate", e))?;
        self.bitrate_bps = bitrate_bps;
        Ok(())
    }
    /// Encodes one picture of the encoder's size. `None` when libvpx emitted nothing.
    pub fn encode(&mut self, picture: &I420Buf, force_keyframe: bool) -> Result<Option<EncodedFrame>, MediaError> {
        debug_assert!(self.fits(picture.width, picture.height));
        self.inner
            .encode(
                &vpx::ImageData::I420 {
                    y: &picture.y,
                    u: &picture.u,
                    v: &picture.v,
                },
                &vpx::EncodeOptions { force_keyframe },
            )
            .map_err(|e| encoder_error("vp8 encode", e))?;
        let mut out = None;
        while let Some(frame) = self.inner.next_frame() {
            out = Some(EncodedFrame {
                data: Bytes::copy_from_slice(frame.data()),
                keyframe: frame.is_keyframe(),
            });
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient(width: usize, height: usize, shift: usize) -> I420Buf {
        let mut buf = I420Buf::new();
        buf.width = width;
        buf.height = height;
        buf.y = (0..width * height).map(|n| ((n + shift) % 200) as u8 + 20).collect();
        let chroma = width.div_ceil(2) * height.div_ceil(2);
        buf.u = vec![128; chroma];
        buf.v = vec![128; chroma];
        buf
    }

    #[test]
    fn first_frame_is_a_keyframe_that_decodes_at_size() {
        let mut encoder = Vp8Encoder::new(64, 48, 500_000).unwrap();
        let frame = encoder.encode(&gradient(64, 48, 0), false).unwrap().unwrap();
        assert!(frame.keyframe);
        let mut decoder = vpx::Decoder::new(vpx::DecoderConfig::new(vpx::DecoderCodec::Vp8)).unwrap();
        decoder.decode(&frame.data).unwrap();
        let decoded = decoder.next_frame().unwrap().unwrap();
        assert_eq!((decoded.width(), decoded.height()), (64, 48));
    }

    #[test]
    fn deltas_follow_and_a_keyframe_can_be_forced() {
        let mut encoder = Vp8Encoder::new(64, 48, 500_000).unwrap();
        encoder.encode(&gradient(64, 48, 0), false).unwrap();
        let delta = encoder.encode(&gradient(64, 48, 1), false).unwrap().unwrap();
        assert!(!delta.keyframe);
        let forced = encoder.encode(&gradient(64, 48, 2), true).unwrap().unwrap();
        assert!(forced.keyframe);
    }

    #[test]
    fn bitrate_changes_apply_and_floor() {
        let mut encoder = Vp8Encoder::new(64, 48, 500_000).unwrap();
        encoder.set_bitrate(800_000).unwrap();
        assert_eq!(encoder.bitrate_bps(), 800_000);
        encoder.set_bitrate(10).unwrap();
        assert_eq!(encoder.bitrate_bps(), MIN_BITRATE_BPS);
    }
}
