//! X17 host media frames (SPEC §4.1, §4.7.3): the only binary WebSocket
//! frames. Sent only by a connection whose `initialize` declared
//! `capabilities.host.media`; any other connection sending binary is closed
//! with 1003. Layout (16 bytes, big-endian), then the payload:
//!
//! | offset | size | field                         |
//! |--------|------|-------------------------------|
//! | 0      | 1    | purpose (`MediaPurpose`)      |
//! | 1      | 1    | flags (`MediaFlags` bits)     |
//! | 2      | 4    | streamId                      |
//! | 6      | 2    | width (pixels)                |
//! | 8      | 2    | height (pixels)               |
//! | 10     | 1    | format (`MediaFormat`)        |
//! | 11     | 5    | zero padding                  |

use mixdog_protocol::JsonValue;
use serde::Deserialize;
use serde::Serialize;

pub const MEDIA_HEADER_LEN: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum MediaPurpose {
    /// In-app browser live-view paint frame for `remote::webrtc`.
    BrowserView,
}

impl MediaPurpose {
    pub const fn byte(self) -> u8 {
        match self {
            Self::BrowserView => 1,
        }
    }

    pub const fn from_byte(value: u8) -> Option<Self> {
        match value {
            1 => Some(Self::BrowserView),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum MediaFormat {
    /// JPEG, as today's `browserRemoteFrame`.
    Jpeg,
}

impl MediaFormat {
    pub const fn byte(self) -> u8 {
        match self {
            Self::Jpeg => 1,
        }
    }

    pub const fn from_byte(value: u8) -> Option<Self> {
        match value {
            1 => Some(Self::Jpeg),
            _ => None,
        }
    }
}

/// Flag bits; unknown bits are a protocol violation.
pub struct MediaFlags;

impl MediaFlags {
    /// The frame shows the fitted layout of a take-over (today's `fitSettled`).
    pub const FIT_SETTLED: u8 = 0b0000_0001;
    /// Fitting the take-over's layout failed (today's `fitFailed`).
    pub const FIT_FAILED: u8 = 0b0000_0010;
    pub const KNOWN: u8 = Self::FIT_SETTLED | Self::FIT_FAILED;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct MediaFrameHeader {
    pub purpose: MediaPurpose,
    pub flags: u8,
    /// Stream id assigned by `host/browser/viewFrames`.
    pub stream_id: u32,
    pub width: u16,
    pub height: u16,
    pub format: MediaFormat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaFrameError {
    /// Shorter than the header.
    Truncated,
    UnknownPurpose(u8),
    UnknownFormat(u8),
    UnknownFlags(u8),
    NonZeroPadding,
    /// Payload above `limits.maxMediaFrameBytes`.
    PayloadTooLarge,
    /// Width or height is zero.
    EmptyGeometry,
}

impl MediaFrameHeader {
    pub fn encode(&self) -> [u8; MEDIA_HEADER_LEN] {
        let mut out = [0u8; MEDIA_HEADER_LEN];
        out[0] = self.purpose.byte();
        out[1] = self.flags;
        out[2..6].copy_from_slice(&self.stream_id.to_be_bytes());
        out[6..8].copy_from_slice(&self.width.to_be_bytes());
        out[8..10].copy_from_slice(&self.height.to_be_bytes());
        out[10] = self.format.byte();
        out
    }

    /// Splits a binary frame into header and payload.
    pub fn decode(
        frame: &[u8],
        max_media_frame_bytes: u64,
    ) -> Result<(Self, &[u8]), MediaFrameError> {
        if frame.len() < MEDIA_HEADER_LEN {
            return Err(MediaFrameError::Truncated);
        }
        let (head, payload) = frame.split_at(MEDIA_HEADER_LEN);
        let purpose =
            MediaPurpose::from_byte(head[0]).ok_or(MediaFrameError::UnknownPurpose(head[0]))?;
        let flags = head[1];
        if flags & !MediaFlags::KNOWN != 0 {
            return Err(MediaFrameError::UnknownFlags(flags));
        }
        let stream_id = u32::from_be_bytes([head[2], head[3], head[4], head[5]]);
        let width = u16::from_be_bytes([head[6], head[7]]);
        let height = u16::from_be_bytes([head[8], head[9]]);
        let format =
            MediaFormat::from_byte(head[10]).ok_or(MediaFrameError::UnknownFormat(head[10]))?;
        if head[11..].iter().any(|byte| *byte != 0) {
            return Err(MediaFrameError::NonZeroPadding);
        }
        if width == 0 || height == 0 {
            return Err(MediaFrameError::EmptyGeometry);
        }
        if payload.len() as u64 > max_media_frame_bytes {
            return Err(MediaFrameError::PayloadTooLarge);
        }
        Ok((
            Self {
                purpose,
                flags,
                stream_id,
                width,
                height,
                format,
            },
            payload,
        ))
    }
}

/// Layout description exported with the golden constants.
pub fn layout_description() -> JsonValue {
    serde_json::json!({
        "headerBytes": MEDIA_HEADER_LEN,
        "byteOrder": "bigEndian",
        "fields": [
            {"name": "purpose", "offset": 0, "size": 1, "values": {"browserView": MediaPurpose::BrowserView.byte()}},
            {"name": "flags", "offset": 1, "size": 1, "bits": {"fitSettled": MediaFlags::FIT_SETTLED, "fitFailed": MediaFlags::FIT_FAILED}},
            {"name": "streamId", "offset": 2, "size": 4},
            {"name": "width", "offset": 6, "size": 2},
            {"name": "height", "offset": 8, "size": 2},
            {"name": "format", "offset": 10, "size": 1, "values": {"jpeg": MediaFormat::Jpeg.byte()}},
            {"name": "padding", "offset": 11, "size": 5}
        ]
    })
}
