//! `initialize.limits` (SPEC §3.1, the only defaults), their startup
//! invariants (P §6.5), request-class caps and WebSocket close codes.

use mixdog_protocol::INLINE_MAX;
use serde::Deserialize;
use serde::Serialize;

use crate::common::RequestClass;

const KIB: u64 = 1024;
const MIB: u64 = 1024 * 1024;

/// The live view's pixel bound per dimension (`MAX_PIXEL_DIMENSION` in
/// `apps/desktop/src/shared/remote-webrtc.ts`, = `MAX_STREAM_DIMENSION` of `remote-browser.ts`).
pub const LIVE_VIEW_MAX_WIDTH: u64 = 4096;
pub const LIVE_VIEW_MAX_HEIGHT: u64 = 4096;

/// Room kept in an inbound frame for the `blob/put` request around its base64 data
/// (JSON-RPC envelope, `opId`, `digest`, `offset`).
const BLOB_PUT_ENVELOPE_BYTES: u64 = 4 * KIB;

/// The largest raw `blob/put` chunk whose base64 (4 bytes per 3, no padding because
/// the result is a multiple of 3) and envelope still fit `max_inbound_frame_bytes`.
fn blob_put_chunk_for(max_inbound_frame_bytes: u64) -> u64 {
    (max_inbound_frame_bytes - BLOB_PUT_ENVELOPE_BYTES) / 4 * 3
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ClassLimits {
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub c0: u32,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub c1: u32,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub c2: u32,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub c3: u32,
}

impl ClassLimits {
    pub fn cap(&self, class: RequestClass) -> u32 {
        match class {
            RequestClass::C0 => self.c0,
            RequestClass::C1 => self.c1,
            RequestClass::C2 => self.c2,
            RequestClass::C3 => self.c3,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub max_inbound_frame_bytes: u64,
    /// Host role only (X17): raw BGRA bound of the pinned live-view size.
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub max_media_frame_bytes: u64,
    /// `INLINE_MAX`.
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub max_item_field_bytes: u64,
    /// Outbound non-snapshot frame bound.
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub max_frame_bytes: u64,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub queue_bytes: u64,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub control_reserve_bytes: u64,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub event_budget_bytes: u64,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub max_snapshot_bytes: u64,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub ring_bytes: u64,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub app_ring_bytes: u64,
    /// Terminal feed replay ring, in characters (`REPLAY_BUFFER_LIMIT`).
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub terminal_ring_chars: u64,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub max_blob_page_bytes: u64,
    /// Raw `blob/put` chunk bound, so the frame stays under `maxInboundFrameBytes` after base64.
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub max_blob_put_chunk_bytes: u64,
    /// Per-connection in-flight cap per request class.
    pub inflight: ClassLimits,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub max_connections: u32,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub heartbeat_tick_ms: u64,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub max_processes: u32,
    /// Per-terminal input buffer before socket reads pause (P §7.3).
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub terminal_input_buffer_bytes: u64,
}

impl Default for Limits {
    fn default() -> Self {
        let queue_bytes = 8 * MIB;
        let control_reserve_bytes = 512 * KIB;
        let inline_max = INLINE_MAX as u64;
        let max_inbound_frame_bytes = 256 * KIB;
        Self {
            max_inbound_frame_bytes,
            max_media_frame_bytes: LIVE_VIEW_MAX_WIDTH * LIVE_VIEW_MAX_HEIGHT * 4,
            max_item_field_bytes: inline_max,
            max_frame_bytes: inline_max + 64 * KIB,
            queue_bytes,
            control_reserve_bytes,
            event_budget_bytes: queue_bytes - control_reserve_bytes,
            max_snapshot_bytes: 3 * MIB,
            ring_bytes: 4 * MIB,
            app_ring_bytes: MIB,
            terminal_ring_chars: 200_000,
            max_blob_page_bytes: MIB,
            max_blob_put_chunk_bytes: blob_put_chunk_for(max_inbound_frame_bytes),
            inflight: ClassLimits {
                c0: 64,
                c1: 16,
                c2: 8,
                c3: 4,
            },
            max_connections: 128,
            heartbeat_tick_ms: 15_000,
            max_processes: 64,
            terminal_input_buffer_bytes: MIB,
        }
    }
}

/// A violated startup invariant; the core refuses to start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LimitsViolation(pub &'static str);

impl Limits {
    /// P §6.5 invariants: the largest frame, including a snapshot, always fits an empty event budget.
    pub fn check(&self) -> Result<(), LimitsViolation> {
        if self.event_budget_bytes + self.control_reserve_bytes != self.queue_bytes {
            return Err(LimitsViolation(
                "eventBudgetBytes = queueBytes - controlReserveBytes",
            ));
        }
        if self.max_snapshot_bytes * 2 > self.event_budget_bytes {
            return Err(LimitsViolation("maxSnapshotBytes <= eventBudgetBytes / 2"));
        }
        if self.max_item_field_bytes * 8 > self.max_snapshot_bytes {
            return Err(LimitsViolation("maxItemFieldBytes <= maxSnapshotBytes / 8"));
        }
        if self.max_frame_bytes != self.max_item_field_bytes + 64 * KIB {
            return Err(LimitsViolation(
                "maxFrameBytes = maxItemFieldBytes + 64 KiB",
            ));
        }
        if self.max_frame_bytes * 4 > self.event_budget_bytes {
            return Err(LimitsViolation("maxFrameBytes <= eventBudgetBytes / 4"));
        }
        // base64 of the raw chunk plus the request's schema-bounded fields.
        if self.max_blob_put_chunk_bytes.div_ceil(3) * 4 + BLOB_PUT_ENVELOPE_BYTES
            > self.max_inbound_frame_bytes
        {
            return Err(LimitsViolation(
                "base64(maxBlobPutChunkBytes) fits maxInboundFrameBytes",
            ));
        }
        Ok(())
    }
}

/// WebSocket close codes (P §4.5, X17).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(into = "u16", try_from = "u16")]
#[cfg_attr(feature = "codegen", ts(type = "1000 | 1001 | 1003 | 1007 | 1008 | 1009 | 4000 | 4001 | 4002"))]
pub enum CloseCode {
    Normal,
    /// Core draining or stopping.
    GoingAway,
    /// Binary frame from a connection without the host media role (X17).
    UnsupportedData,
    InvalidFrame,
    /// Authentication or Origin refusal.
    PolicyViolation,
    FrameTooBig,
    /// Control reserve exhausted.
    SlowConsumer,
    /// Two heartbeat ticks without any received frame.
    PeerUnresponsive,
    /// `initialize` version refusal.
    VersionRefused,
}

impl CloseCode {
    pub const ALL: &'static [CloseCode] = &[
        Self::Normal,
        Self::GoingAway,
        Self::UnsupportedData,
        Self::InvalidFrame,
        Self::PolicyViolation,
        Self::FrameTooBig,
        Self::SlowConsumer,
        Self::PeerUnresponsive,
        Self::VersionRefused,
    ];

    pub const fn code(self) -> u16 {
        match self {
            Self::Normal => 1000,
            Self::GoingAway => 1001,
            Self::UnsupportedData => 1003,
            Self::InvalidFrame => 1007,
            Self::PolicyViolation => 1008,
            Self::FrameTooBig => 1009,
            Self::SlowConsumer => 4000,
            Self::PeerUnresponsive => 4001,
            Self::VersionRefused => 4002,
        }
    }

    pub const fn reason(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::GoingAway => "draining",
            Self::UnsupportedData => "binaryNotAllowed",
            Self::InvalidFrame => "invalidFrame",
            Self::PolicyViolation => "policy",
            Self::FrameTooBig => "frameTooBig",
            Self::SlowConsumer => "slowConsumer",
            Self::PeerUnresponsive => "peerUnresponsive",
            Self::VersionRefused => "versionRefused",
        }
    }
}

impl From<CloseCode> for u16 {
    fn from(value: CloseCode) -> Self {
        value.code()
    }
}

impl TryFrom<u16> for CloseCode {
    type Error = String;

    fn try_from(value: u16) -> Result<Self, Self::Error> {
        Self::ALL
            .iter()
            .copied()
            .find(|code| code.code() == value)
            .ok_or_else(|| format!("unknown close code {value}"))
    }
}
