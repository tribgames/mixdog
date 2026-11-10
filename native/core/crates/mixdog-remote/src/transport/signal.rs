//! The MXT transport's signalling and media-adapter messages (`shared/remote-transport.ts`
//! `parseRemoteTransportSignal`, `readRemoteTransportMedia`). Every check, its order and its error
//! text are Node's (`tests/it/transport_signals.rs` replays the recorded outcomes). Lengths count
//! UTF-16 units.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::consts::MAX_CONTROL_PLAINTEXT_BYTES;
use super::consts::MAX_DETAIL_CHARS;
use super::consts::MEDIA_CHUNK_MAX_CHARS;
use crate::webrtc::config::Candidate;
use crate::webrtc::config::IceServer;
use crate::webrtc::signal::Fingerprint;
use crate::webrtc::signal::candidate_json;
use crate::webrtc::signal::ice_servers_json;
use crate::webrtc::signal::js_string;
use crate::webrtc::signal::parse_candidate;
use crate::webrtc::signal::parse_ice_servers;
use crate::webrtc::signal::parse_sdp;
use crate::webrtc::signal::sdp_fingerprints;

/// A refused message: Node's `TypeError` text.
pub type Refusal = String;

/// The sender's role: only the desktop offers, only the client answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Desktop,
    Client,
}

fn fail<T>(what: &str) -> Result<T, Refusal> {
    Err(format!("remote transport: invalid {what}."))
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn record<'a>(value: &'a Value, what: &str) -> Result<&'a Map<String, Value>, Refusal> {
    match value {
        Value::Object(fields) => Ok(fields),
        _ => fail(what),
    }
}

/// `Number.isSafeInteger` of a JSON number.
fn safe_integer(value: &Value) -> Option<f64> {
    let number = value.as_f64()?;
    (number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0).then_some(number)
}

fn positive_integer(value: &Value, what: &str) -> Result<u64, Refusal> {
    match safe_integer(value) {
        Some(n) if n >= 1.0 => Ok(n as u64),
        _ => fail(what),
    }
}

fn bounded_text(value: &Value, max: usize, what: &str) -> Result<String, Refusal> {
    match value {
        Value::String(text) if utf16_len(text) <= max => Ok(text.clone()),
        _ => fail(what),
    }
}

static TOKEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]+$").expect("token"));

fn token(value: &Value, what: &str, min: usize, max: usize) -> Result<String, Refusal> {
    let text = bounded_text(value, max, what)?;
    if utf16_len(&text) < min || !TOKEN.is_match(&text) {
        return fail(what);
    }
    Ok(text)
}

// ---- signals ------------------------------------------------------------------------------------

/// `RemoteTransportCloseReason`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseReason {
    Superseded,
    NegotiationTimeout,
    IceFailed,
    DtlsFailed,
    FingerprintMismatch,
    ChannelFailed,
    Stall,
    /// The client asks the desktop for a fresh offer (ICE restart or new peer).
    Restart,
    PeerHostUnavailable,
    SessionEnded,
    Revoked,
    Suspended,
    ProtocolError,
}

impl CloseReason {
    const ALL: [Self; 13] = [
        Self::Superseded,
        Self::NegotiationTimeout,
        Self::IceFailed,
        Self::DtlsFailed,
        Self::FingerprintMismatch,
        Self::ChannelFailed,
        Self::Stall,
        Self::Restart,
        Self::PeerHostUnavailable,
        Self::SessionEnded,
        Self::Revoked,
        Self::Suspended,
        Self::ProtocolError,
    ];

    pub const fn wire_name(self) -> &'static str {
        match self {
            Self::Superseded => "superseded",
            Self::NegotiationTimeout => "negotiation-timeout",
            Self::IceFailed => "ice-failed",
            Self::DtlsFailed => "dtls-failed",
            Self::FingerprintMismatch => "fingerprint-mismatch",
            Self::ChannelFailed => "channel-failed",
            Self::Stall => "stall",
            Self::Restart => "restart",
            Self::PeerHostUnavailable => "peer-host-unavailable",
            Self::SessionEnded => "session-ended",
            Self::Revoked => "revoked",
            Self::Suspended => "suspended",
            Self::ProtocolError => "protocol-error",
        }
    }

    pub fn from_wire(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|reason| reason.wire_name() == name)
    }
}

/// Every signal names the transport session, the peer connection the desktop minted, and the
/// generation, which rises per session with every offer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignalRef {
    pub session_id: String,
    pub connection_id: String,
    pub generation: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Signal {
    Offer { at: SignalRef, sdp: String, fingerprints: Vec<Fingerprint>, ice_servers: Vec<IceServer> },
    Answer { at: SignalRef, sdp: String, fingerprints: Vec<Fingerprint> },
    Candidate { at: SignalRef, candidate: Option<Candidate> },
    Close { at: SignalRef, reason: CloseReason, detail: Option<String> },
}

impl Signal {
    pub fn at(&self) -> &SignalRef {
        match self {
            Self::Offer { at, .. } | Self::Answer { at, .. } | Self::Candidate { at, .. } | Self::Close { at, .. } => at,
        }
    }

    pub fn to_json(&self) -> Value {
        let at = self.at();
        let mut out = json!({ "v": 1, "sessionId": at.session_id, "connectionId": at.connection_id, "generation": at.generation });
        let fields = out.as_object_mut().expect("object");
        let prints = |list: &[Fingerprint]| Value::Array(list.iter().map(Fingerprint::to_json).collect());
        match self {
            Self::Offer { sdp, fingerprints, ice_servers, .. } => {
                fields.insert("t".into(), json!("offer"));
                fields.insert("sdp".into(), json!(sdp));
                fields.insert("fingerprints".into(), prints(fingerprints));
                fields.insert("iceServers".into(), ice_servers_json(ice_servers));
            }
            Self::Answer { sdp, fingerprints, .. } => {
                fields.insert("t".into(), json!("answer"));
                fields.insert("sdp".into(), json!(sdp));
                fields.insert("fingerprints".into(), prints(fingerprints));
            }
            Self::Candidate { candidate, .. } => {
                fields.insert("t".into(), json!("candidate"));
                fields.insert("candidate".into(), candidate_json(candidate));
            }
            Self::Close { reason, detail, .. } => {
                fields.insert("t".into(), json!("close"));
                fields.insert("reason".into(), json!(reason.wire_name()));
                if let Some(detail) = detail {
                    fields.insert("detail".into(), json!(detail));
                }
            }
        }
        out
    }
}

fn signal_ref(input: &Map<String, Value>) -> Result<SignalRef, Refusal> {
    let version = input.get("v").and_then(Value::as_f64);
    if version != Some(1.0) {
        return fail("version");
    }
    let absent = Value::Null;
    let get = |name: &str| input.get(name).unwrap_or(&absent);
    Ok(SignalRef {
        // The E2EE challenge: 32 random bytes, base64url.
        session_id: token(get("sessionId"), "session id", 43, 43)?,
        connection_id: token(get("connectionId"), "connection id", 8, 64)?,
        generation: positive_integer(get("generation"), "generation")?,
    })
}

/// The SDP check bounded first to what one control box carries.
fn sdp(value: &Value) -> Result<String, Refusal> {
    if let Value::String(text) = value
        && utf16_len(text) > MAX_CONTROL_PLAINTEXT_BYTES
    {
        return fail("sdp size");
    }
    parse_sdp(value)
}

/// `declared.map(e => `${e.algorithm} ${e.value}`)`: a property read of any JSON value, so only
/// null (which has none) throws.
fn declared_key(entry: &Value) -> Option<String> {
    if entry.is_null() {
        return None;
    }
    let read = |name: &str| match entry {
        Value::Object(fields) => fields.get(name).map_or_else(|| "undefined".to_owned(), js_string),
        _ => "undefined".to_owned(),
    };
    Some(format!("{} {}", read("algorithm"), read("value")))
}

fn fingerprints_for(sdp_text: &str, value: &Value) -> Result<Vec<Fingerprint>, Refusal> {
    let Value::Array(declared) = value else { return fail("fingerprints") };
    if declared.is_empty() || declared.len() > 3 {
        return fail("fingerprints");
    }
    // The SDP's own attributes must be exactly the declared set; the SDP's copies, in canonical
    // form, are returned.
    let Ok(in_sdp) = sdp_fingerprints(sdp_text) else { return fail("fingerprints") };
    let mut seen: Vec<String> = in_sdp.iter().map(|entry| format!("{} {}", entry.algorithm, entry.value)).collect();
    seen.sort();
    seen.dedup();
    let mut sent = Vec::with_capacity(declared.len());
    for entry in declared {
        match declared_key(entry) {
            Some(key) => sent.push(key),
            None => return fail("fingerprints"),
        }
    }
    sent.sort();
    sent.dedup();
    if seen.is_empty() || seen.len() != sent.len() || sent.iter().any(|key| !seen.contains(key)) {
        return fail("fingerprints");
    }
    sdp_fingerprints(sdp_text)
}

/// A signal opened from the control domain, held to one control box: whatever passes can be sealed
/// and carried as it is.
pub fn parse_signal(value: &Value, from: Role) -> Result<Signal, Refusal> {
    let signal = parse_signal_fields(value, from)?;
    if signal.to_json().to_string().len() > MAX_CONTROL_PLAINTEXT_BYTES {
        return fail("control size");
    }
    Ok(signal)
}

fn parse_signal_fields(value: &Value, from: Role) -> Result<Signal, Refusal> {
    let input = record(value, "signal")?;
    let at = signal_ref(input)?;
    let absent = Value::Null;
    let get = |name: &str| input.get(name).unwrap_or(&absent);
    match input.get("t").and_then(Value::as_str) {
        Some("offer") => {
            if from != Role::Desktop {
                return fail("offer direction");
            }
            let text = sdp(get("sdp"))?;
            let fingerprints = fingerprints_for(&text, get("fingerprints"))?;
            let ice_servers = parse_ice_servers(get("iceServers"))?;
            Ok(Signal::Offer { at, sdp: text, fingerprints, ice_servers })
        }
        Some("answer") => {
            if from != Role::Client {
                return fail("answer direction");
            }
            let text = sdp(get("sdp"))?;
            let fingerprints = fingerprints_for(&text, get("fingerprints"))?;
            Ok(Signal::Answer { at, sdp: text, fingerprints })
        }
        // A missing member is `undefined`, which is not the null that ends the candidates: refused as any non-record.
        Some("candidate") => Ok(Signal::Candidate { at, candidate: parse_candidate(input.get("candidate").unwrap_or(&Value::Bool(false)))? }),
        Some("close") => {
            let Some(reason) = get("reason").as_str().and_then(CloseReason::from_wire) else { return fail("close reason") };
            let detail = match input.get("detail") {
                None => None,
                Some(detail) => Some(bounded_text(detail, MAX_DETAIL_CHARS, "close detail")?),
            };
            Ok(Signal::Close { at, reason, detail })
        }
        _ => fail("signal type"),
    }
}

// ---- media adapter messages -----------------------------------------------------------------------

pub const MEDIA_TYPE: &str = "transport-media";

const MEDIA_STATUSES: [u16; 7] = [200, 403, 404, 405, 412, 416, 500];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Media {
    Request { id: String, asset_id: String, variant: String, range: String, enc: String },
    Head { id: String, status: u16 },
    Chunk { id: String, frame: String },
    End { id: String },
    Cancel { id: String },
    Error { id: String },
}

impl Media {
    pub fn id(&self) -> &str {
        match self {
            Self::Request { id, .. }
            | Self::Head { id, .. }
            | Self::Chunk { id, .. }
            | Self::End { id }
            | Self::Cancel { id }
            | Self::Error { id } => id,
        }
    }

    pub fn to_json(&self) -> Value {
        let id = self.id();
        match self {
            Self::Request { asset_id, variant, range, enc, .. } => {
                json!({ "type": MEDIA_TYPE, "op": "request", "id": id, "assetId": asset_id, "variant": variant, "range": range, "enc": enc })
            }
            Self::Head { status, .. } => json!({ "type": MEDIA_TYPE, "op": "head", "id": id, "status": status }),
            Self::Chunk { frame, .. } => json!({ "type": MEDIA_TYPE, "op": "chunk", "id": id, "frame": frame }),
            Self::End { .. } => json!({ "type": MEDIA_TYPE, "op": "end", "id": id }),
            Self::Cancel { .. } => json!({ "type": MEDIA_TYPE, "op": "cancel", "id": id }),
            Self::Error { .. } => json!({ "type": MEDIA_TYPE, "op": "error", "id": id }),
        }
    }
}

static ASSET_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-fA-F-]{8,64}$").expect("asset id"));
static RANGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^bytes=[0-9]{0,16}-[0-9]{0,16}$").expect("range"));
static FRAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{40,}$").expect("frame"));

/// A media adapter message, or `None` when the payload is not one. Requests and cancels come from
/// the client only.
pub fn read_media(value: &Value, from: Role) -> Result<Option<Media>, Refusal> {
    let Value::Object(input) = value else { return Ok(None) };
    if input.get("type").and_then(Value::as_str) != Some(MEDIA_TYPE) {
        return Ok(None);
    }
    let absent = Value::Null;
    let get = |name: &str| input.get(name).unwrap_or(&absent);
    let id = token(get("id"), "media id", 1, 64)?;
    let op = get("op").as_str();
    let client_op = matches!(op, Some("request" | "cancel"));
    if client_op != (from == Role::Client) {
        return fail("media direction");
    }
    match op {
        Some("request") => {
            let asset_id = bounded_text(get("assetId"), 64, "media asset")?;
            if !ASSET_ID.is_match(&asset_id) {
                return fail("media asset");
            }
            let range = bounded_text(get("range"), 64, "media range")?;
            if !range.is_empty() && !RANGE.is_match(&range) {
                return fail("media range");
            }
            Ok(Some(Media::Request {
                id,
                asset_id,
                variant: token(get("variant"), "media variant", 1, 32)?,
                range,
                enc: token(get("enc"), "media scheme", 1, 16)?,
            }))
        }
        Some("head") => {
            let status = get("status").as_u64().and_then(|n| u16::try_from(n).ok()).filter(|n| MEDIA_STATUSES.contains(n));
            match status {
                Some(status) => Ok(Some(Media::Head { id, status })),
                None => fail("media status"),
            }
        }
        Some("chunk") => {
            let frame = bounded_text(get("frame"), MEDIA_CHUNK_MAX_CHARS, "media frame")?;
            if !FRAME.is_match(&frame) {
                return fail("media frame");
            }
            Ok(Some(Media::Chunk { id, frame }))
        }
        Some("end") => Ok(Some(Media::End { id })),
        Some("cancel") => Ok(Some(Media::Cancel { id })),
        Some("error") => Ok(Some(Media::Error { id })),
        _ => fail("media op"),
    }
}
