//! One paired phone's encrypted channel: the legacy single-key stream, or the directional
//! `app`/`control` keys of a negotiated transport session.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use serde_json::{Value, json};

use super::control::{ControlLane, ControlLanes, LaneSlot};
use super::pack::{MAX_PLAINTEXT_BYTES, pack_plaintext, unpack_plaintext};
use super::{
    BINARY_MAGIC, BOX_HEADER_BYTES, CONTEXT, CONTROL_MAGIC, E2eeError, TRANSPORT_MAX_BOX_BYTES,
    TRANSPORT_MAX_PLAINTEXT_BYTES, VERSION, b64, is_b64url_len, random, unb64,
};

/// A box as it arrives from the carrier.
#[derive(Clone, Copy, Debug)]
pub enum Wire<'a> {
    Text(&'a str),
    Binary(&'a [u8]),
}

/// A sealed box ready for the carrier.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Sealed {
    Text(String),
    Binary(Vec<u8>),
}

#[derive(Debug, PartialEq, Eq)]
pub enum ControlOpen {
    Fresh { sequence: u64, value: Vec<u8> },
    Stale { sequence: u64 },
}

pub(crate) struct TransportKeys {
    pub app_send: Aes256Gcm,
    pub app_receive: Aes256Gcm,
    pub control_send: Aes256Gcm,
    pub control_receive: Aes256Gcm,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Role {
    Client,
    Server,
}

/// Handshake confirmation of a transport offer. `send`: the server's transcript for
/// `e2ee-ready`. `expect`: what a client that saw the offer must read back.
#[derive(Default)]
pub(crate) struct HandshakeState {
    pub send: Option<String>,
    pub expect: Option<(String, bool)>,
}

pub struct Channel {
    pub(crate) role: Role,
    pub(crate) key: Aes256Gcm,
    pub(crate) compression: bool,
    pub(crate) media_key: Option<[u8; 32]>,
    pub(crate) transport: Option<TransportKeys>,
    pub(crate) handshake: HandshakeState,
    send_sequence: u64,
    receive_sequence: u64,
    control_send_sequence: u64,
    lanes: ControlLanes,
    send_broken: bool,
    confirmed: bool,
}

pub(crate) fn cipher(key: &[u8; 32]) -> Aes256Gcm {
    Aes256Gcm::new_from_slice(key).expect("32-byte key")
}

fn direction(sending: bool, role: Role) -> &'static str {
    if (role == Role::Client) == sending { "client-to-server" } else { "server-to-client" }
}

pub(crate) fn encode_binary_box(sequence: u64, nonce: &[u8; 12], ciphertext: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(BOX_HEADER_BYTES + ciphertext.len());
    out.extend_from_slice(&BINARY_MAGIC);
    out.extend_from_slice(&sequence.to_be_bytes());
    out.extend_from_slice(nonce);
    out.extend_from_slice(ciphertext);
    out
}

struct BoxParts<'a> {
    sequence: u64,
    nonce: [u8; 12],
    ciphertext: std::borrow::Cow<'a, [u8]>,
}

fn decode_binary_box<'a>(bytes: &'a [u8], magic: &[u8; 4]) -> Option<BoxParts<'a>> {
    if bytes.len() < BOX_HEADER_BYTES + 16 || bytes[..4] != magic[..] {
        return None;
    }
    let sequence = u64::from_be_bytes(bytes[4..12].try_into().ok()?);
    if !(1..=9_007_199_254_740_991).contains(&sequence) {
        return None;
    }
    Some(BoxParts {
        sequence,
        nonce: bytes[12..24].try_into().ok()?,
        ciphertext: std::borrow::Cow::Borrowed(&bytes[BOX_HEADER_BYTES..]),
    })
}

fn decode_text_box(text: &str) -> Result<BoxParts<'static>, E2eeError> {
    let bad = E2eeError::Invalid("Expected an encrypted relay frame.");
    let parsed: Value = serde_json::from_str(text).map_err(|_| bad.clone())?;
    let ok = parsed["type"] == "e2ee-box" && parsed["version"] == VERSION;
    let sequence = parsed["sequence"].as_u64().filter(|s| (1..=9_007_199_254_740_991).contains(s));
    let nonce = parsed["nonce"].as_str().filter(|n| is_b64url_len(n, 16));
    let ct = parsed["ciphertext"]
        .as_str()
        .filter(|c| c.len() >= 22 && c.len() % 4 != 1 && c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
    let (true, Some(sequence), Some(nonce), Some(ct)) = (ok, sequence, nonce, ct) else {
        return Err(bad);
    };
    let nonce: [u8; 12] = unb64(nonce)?.try_into().map_err(|_| E2eeError::Invalid("Invalid relay frame nonce."))?;
    Ok(BoxParts { sequence, nonce, ciphertext: std::borrow::Cow::Owned(unb64(ct)?) })
}

impl Channel {
    pub(crate) fn new(
        role: Role,
        key: [u8; 32],
        compression: bool,
        media_key: Option<[u8; 32]>,
        transport: Option<TransportKeys>,
        handshake: HandshakeState,
    ) -> Self {
        let confirmed = handshake.expect.is_none();
        Self {
            role,
            key: cipher(&key),
            compression,
            media_key,
            transport,
            handshake,
            send_sequence: 0,
            receive_sequence: 0,
            control_send_sequence: 0,
            lanes: ControlLanes::default(),
            send_broken: false,
            confirmed,
        }
    }

    pub fn transport_enabled(&self) -> bool {
        self.transport.is_some()
    }

    /// The session's media key; `None` unless the challenge offered `mediaE2ee`.
    pub fn media_key(&self) -> Option<&[u8; 32]> {
        self.media_key.as_ref()
    }

    /// Server: the members to add to `e2ee-ready` (authenticated by this channel).
    pub fn handshake_confirmation(&self) -> Option<&str> {
        self.handshake.send.as_deref()
    }

    /// Client: checks the server's decrypted `e2ee-ready` against the transcript it computed.
    pub fn confirm_handshake(&mut self, ready: &Value) -> Result<(), E2eeError> {
        let Some((expected, offered)) = self.handshake.expect.as_ref() else {
            return Ok(());
        };
        if self.confirmed {
            return Ok(());
        }
        let mismatch = match ready.get("transcript").and_then(Value::as_str) {
            None => *offered,
            Some(t) => t != expected,
        };
        if mismatch {
            return Err(E2eeError::TranscriptMismatch);
        }
        self.confirmed = true;
        Ok(())
    }

    fn app_aad(&self, direction: &str, sequence: u64) -> Vec<u8> {
        if self.transport.is_some() {
            format!("{CONTEXT}\0app\0{direction}\0{sequence}").into_bytes()
        } else {
            format!("{CONTEXT}\0{direction}\0{sequence}").into_bytes()
        }
    }

    /// Seals one application message (`plaintext` is the JSON text of the frame, byte for byte).
    pub fn seal(&mut self, plaintext: &[u8], binary: bool) -> Result<Sealed, E2eeError> {
        if !self.confirmed {
            return Err(E2eeError::Unconfirmed);
        }
        if self.send_broken {
            return Err(E2eeError::Broken);
        }
        // Everything that can refuse runs before the sequence is assigned.
        if self.transport.is_some() && plaintext.len() > TRANSPORT_MAX_PLAINTEXT_BYTES {
            return Err(E2eeError::TooLarge);
        }
        let packed = pack_plaintext(plaintext, self.compression)?;
        self.send_sequence += 1;
        let sequence = self.send_sequence;
        let nonce: [u8; 12] = random();
        let aad = self.app_aad(direction(true, self.role), sequence);
        let cipher = self.transport.as_ref().map_or(&self.key, |t| &t.app_send);
        let ciphertext = match cipher.encrypt(Nonce::from_slice(&nonce), Payload { msg: &packed, aad: &aad }) {
            Ok(c) => c,
            Err(_) => {
                if self.transport.is_some() {
                    self.send_broken = true;
                }
                return Err(E2eeError::Invalid("encryption failed"));
            }
        };
        Ok(if binary {
            Sealed::Binary(encode_binary_box(sequence, &nonce, &ciphertext))
        } else {
            Sealed::Text(
                json!({"type":"e2ee-box","version":VERSION,"sequence":sequence,"nonce":b64(&nonce),"ciphertext":b64(&ciphertext)})
                    .to_string(),
            )
        })
    }

    /// Opens one application box; the plaintext is the frame's JSON text.
    pub fn open(&mut self, wire: Wire<'_>) -> Result<Vec<u8>, E2eeError> {
        let parts = match wire {
            Wire::Binary(bytes) => decode_binary_box(bytes, &BINARY_MAGIC)
                .ok_or(E2eeError::Invalid("Expected an encrypted relay frame."))?,
            Wire::Text(text) => decode_text_box(text)?,
        };
        if parts.sequence <= self.receive_sequence {
            return Err(E2eeError::Replay);
        }
        if self.transport.is_some() && parts.ciphertext.len() > TRANSPORT_MAX_BOX_BYTES - BOX_HEADER_BYTES {
            return Err(E2eeError::TooLarge);
        }
        let aad = self.app_aad(direction(false, self.role), parts.sequence);
        let cipher = self.transport.as_ref().map_or(&self.key, |t| &t.app_receive);
        let plaintext = cipher
            .decrypt(Nonce::from_slice(&parts.nonce), Payload { msg: &parts.ciphertext, aad: &aad })
            .map_err(|_| E2eeError::Auth)?;
        let limit = if self.transport.is_some() { TRANSPORT_MAX_PLAINTEXT_BYTES } else { MAX_PLAINTEXT_BYTES };
        let value = unpack_plaintext(&plaintext, limit)?;
        self.receive_sequence = parts.sequence;
        Ok(value)
    }

    fn transport_keys(&self) -> Result<&TransportKeys, E2eeError> {
        self.transport.as_ref().ok_or(E2eeError::Invalid("This relay session has no transport control domain."))
    }

    fn control_aad(&self, sending: bool, lane: &ControlLane, sequence: u64) -> Vec<u8> {
        format!("{CONTEXT}\0control\0{}\0{}\0{sequence}", direction(sending, self.role), lane.label()).into_bytes()
    }

    pub fn register_control_lane(&mut self, lane: &ControlLane) -> Result<(), E2eeError> {
        self.lanes.register(lane)
    }

    pub fn activate_control_lane(&mut self, lane: &ControlLane) -> Result<(), E2eeError> {
        self.lanes.activate(lane)
    }

    pub fn retire_control_lane(&mut self, lane: &ControlLane) -> Result<(), E2eeError> {
        self.lanes.retire(lane)
    }

    /// `(lanes retained, epoch floor)`.
    pub fn control_lane_state(&self) -> (usize, u64) {
        self.lanes.state()
    }

    /// `MXC\x01 | u64 sequence | nonce(12) | ciphertext`, the lane bound into the AAD.
    pub fn seal_control(&mut self, plaintext: &[u8], lane: &ControlLane) -> Result<Vec<u8>, E2eeError> {
        self.transport_keys()?;
        if !self.confirmed {
            return Err(E2eeError::Unconfirmed);
        }
        if matches!(self.lanes.slot(lane)?, LaneSlot::Retired) {
            return Err(E2eeError::Invalid("Control lane epoch is retired."));
        }
        self.control_send_sequence += 1;
        let sequence = self.control_send_sequence;
        let nonce: [u8; 12] = random();
        let aad = self.control_aad(true, lane, sequence);
        let keys = self.transport_keys()?;
        let ct = keys
            .control_send
            .encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext, aad: &aad })
            .map_err(|_| E2eeError::Invalid("encryption failed"))?;
        let mut out = encode_binary_box(sequence, &nonce, &ct);
        out[..4].copy_from_slice(&CONTROL_MAGIC);
        Ok(out)
    }

    /// Opens a control box that arrived on `lane`. A sequence at or below the lane's
    /// high-water mark, or any box on a retired lane, is `Stale`, never an error.
    pub fn open_control(&mut self, raw: &[u8], lane: &ControlLane) -> Result<ControlOpen, E2eeError> {
        self.transport_keys()?;
        let parts = decode_binary_box(raw, &CONTROL_MAGIC)
            .ok_or(E2eeError::Invalid("Expected a transport control box."))?;
        let slot = self.lanes.slot(lane)?;
        match self.lanes.high_water(&slot) {
            None => return Ok(ControlOpen::Stale { sequence: parts.sequence }),
            Some(high) if parts.sequence <= high => return Ok(ControlOpen::Stale { sequence: parts.sequence }),
            Some(_) => {}
        }
        let aad = self.control_aad(false, lane, parts.sequence);
        let value = self
            .transport_keys()?
            .control_receive
            .decrypt(Nonce::from_slice(&parts.nonce), Payload { msg: &parts.ciphertext, aad: &aad })
            .map_err(|_| E2eeError::Auth)?;
        let slot = self.lanes.slot(lane)?;
        if self.lanes.high_water(&slot).is_none_or(|high| parts.sequence <= high) {
            return Ok(ControlOpen::Stale { sequence: parts.sequence });
        }
        self.lanes.set_high_water(&slot, parts.sequence);
        Ok(ControlOpen::Fresh { sequence: parts.sequence, value })
    }
}
