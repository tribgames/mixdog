//! Live-view video (SPEC §4.7.2–4.7.3): frame sources (screen, secure
//! desktop, in-app browser view) feeding a WebRTC video track. The core
//! implements VP8 only; the offer contains only codecs the phone lists in
//! `receiveCodecs`.

use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum PixelFormat {
    Bgra,
    /// Secure-desktop helper frames.
    Bgrx,
    I420,
    /// Browser-view paint frames.
    Jpeg,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct VideoFrame {
    pub width: u32,
    pub height: u32,
    /// Bytes per row for raw formats; 0 for `Jpeg`.
    pub stride: u32,
    pub format: PixelFormat,
    pub data: Bytes,
    /// Increases by one per frame of a source.
    pub seq: u64,
    /// Capture time on the source's monotonic clock.
    pub captured_at: Duration,
}

impl VideoFrame {
    /// Byte length a raw frame must have.
    pub fn required_len(&self) -> Option<usize> {
        match self.format {
            PixelFormat::Bgra | PixelFormat::Bgrx => {
                Some(self.stride as usize * self.height as usize)
            }
            PixelFormat::I420 => {
                let (w, h) = (self.width as usize, self.height as usize);
                Some(w * h + 2 * (w.div_ceil(2) * h.div_ceil(2)))
            }
            PixelFormat::Jpeg => None,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum FrameSourceKind {
    Screen { display: u32 },
    SecureDesktop,
    BrowserView { tab_id: String },
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum MediaError {
    Unavailable { reason: String },
    InvalidFrame { reason: String },
    Encoder { detail: String },
}

/// Frames arrive at the source's own cadence (capture events, helper
/// cadence, browser paints); the track never polls on a timer.
#[async_trait]
pub trait MediaFrameSource: Send {
    fn kind(&self) -> FrameSourceKind;
    /// `Ok(None)` ends the source.
    async fn next_frame(&mut self) -> Result<Option<VideoFrame>, MediaError>;
}

/// The only codec the core encodes.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum VideoCodec {
    Vp8,
}

impl VideoCodec {
    pub const fn mime_type(self) -> &'static str {
        match self {
            Self::Vp8 => "video/VP8",
        }
    }
}

/// Codec for the offer, from the phone's `receiveCodecs` MIME types
/// (case-insensitive per RFC 6838). `None` when the phone cannot receive VP8.
pub fn negotiate_codec(receive_codecs: &[String]) -> Option<VideoCodec> {
    let vp8 = VideoCodec::Vp8.mime_type();
    receive_codecs
        .iter()
        .any(|c| c.eq_ignore_ascii_case(vp8))
        .then_some(VideoCodec::Vp8)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct EncodingParams {
    pub max_bitrate_bps: Option<u32>,
    pub max_framerate: Option<u32>,
    /// Degradation preference is always `maintain-resolution`.
    pub maintain_resolution: bool,
}

impl EncodingParams {
    /// Screen share default (`maxFrameRate` 30).
    pub const SCREEN_DEFAULT: Self = Self {
        max_bitrate_bps: None,
        max_framerate: Some(30),
        maintain_resolution: true,
    };
}

/// One outgoing video track; encodes on its own `webrtc-media` thread.
pub trait VideoTrack: Send + Sync {
    fn codec(&self) -> VideoCodec;
    /// Replaces the current source (screen ↔ secure desktop switch).
    fn set_source(&self, source: Box<dyn MediaFrameSource>);
    /// Applied from phone commands.
    fn set_encoding(&self, params: EncodingParams) -> Result<(), MediaError>;
    fn encoding(&self) -> EncodingParams;
    fn request_keyframe(&self);
    fn stop(&self);
}
