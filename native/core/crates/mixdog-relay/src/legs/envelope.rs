//! The wire forms between the relay and a desktop leg (`lib/relay-binary-frame.mjs`, `isTransportFrame` and the phone ping
//! of `lib/relay-legs.mjs`): the binary routing envelope, the JSON wrapper a text frame rides in when the leg has not
//! acknowledged text in the envelope, and the carrier magic the relay recognises without reading the payload.

use crate::ids::is_routing_id;
use crate::js;

/// The first four bytes of a routing envelope: `MXR\x01`.
pub const MAGIC: [u8; 4] = [0x4d, 0x58, 0x52, 0x01];
/// Magic, flags and id length. The envelope overhead is this plus the client id: a FIXED cost, which is what lets a hop
/// promise that a message of size N still fits. The JSON wrapper cannot promise that: it escapes the payload it carries.
pub const HEADER_BYTES: usize = 6;
const FLAG_DROPPABLE: u8 = 1;
/// The payload is UTF-8 text the receiver hands on as a string.
const FLAG_TEXT: u8 = 2;
const MAX_ID_BYTES: usize = 64;

/// Direct-transport carrier messages start with `MXT\x01`, in clear, ahead of the encrypted box. They are binary frames
/// only, so a text `frame` can never be one; the relay decrypts nothing.
pub const TRANSPORT_MAGIC: [u8; 4] = [0x4d, 0x58, 0x54, 0x01];

/// A phone text message that starts with this is a liveness probe, answered at the relay.
pub const PHONE_PING_PREFIX: &str = "{\"ping\"";
/// The relay's own answer to a phone liveness probe.
pub const PHONE_PONG: &str = "{\"pong\":1}";

/// The client id of an envelope to encode is not 1 to 64 bytes (Node throws `TypeError('clientId is invalid.')`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidClientId;

impl std::fmt::Display for InvalidClientId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("clientId is invalid.")
    }
}

impl std::error::Error for InvalidClientId {}

/// One decoded routing envelope; `data` borrows the received bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decoded<'a> {
    pub client_id: String,
    pub droppable: bool,
    /// Older senders never set the text bit, so such a frame decodes with `text` false and `data` as bytes.
    pub text: bool,
    pub data: &'a [u8],
}

/// `encodeRelayBinaryFrame`: `MXR\x01`, flags (bit 0 droppable, bit 1 text), id length, the id, the payload.
pub fn encode_frame(client_id: &str, data: &[u8], droppable: bool, text: bool) -> Result<Vec<u8>, InvalidClientId> {
    let id = client_id.as_bytes();
    if id.is_empty() || id.len() > MAX_ID_BYTES {
        return Err(InvalidClientId);
    }
    let mut frame = Vec::with_capacity(HEADER_BYTES + id.len() + data.len());
    frame.extend_from_slice(&MAGIC);
    frame.push(if droppable { FLAG_DROPPABLE } else { 0 } | if text { FLAG_TEXT } else { 0 });
    frame.push(id.len() as u8);
    frame.extend_from_slice(id);
    frame.extend_from_slice(data);
    Ok(frame)
}

/// `decodeRelayBinaryFrame`: `None` for a short frame, another magic, an id length outside 1 to 64 or past the frame, or
/// an id that is not a routing id.
pub fn decode_frame(raw: &[u8]) -> Option<Decoded<'_>> {
    if raw.len() < HEADER_BYTES + 1 || raw[..4] != MAGIC {
        return None;
    }
    let id_len = usize::from(raw[5]);
    if !(1..=MAX_ID_BYTES).contains(&id_len) || raw.len() < HEADER_BYTES + id_len {
        return None;
    }
    let client_id = js::decode_utf8(&raw[HEADER_BYTES..HEADER_BYTES + id_len]);
    if !is_routing_id(&client_id) {
        return None;
    }
    Some(Decoded {
        client_id: client_id.into_owned(),
        droppable: raw[4] & FLAG_DROPPABLE != 0,
        text: raw[4] & FLAG_TEXT != 0,
        data: &raw[HEADER_BYTES + id_len..],
    })
}

/// `isTransportFrame`: a carrier message starts with `MXT\x01`. Never droppable.
pub fn is_transport_frame(data: &[u8]) -> bool {
    data.len() >= TRANSPORT_MAGIC.len() && data[..4] == TRANSPORT_MAGIC
}

/// A phone text message that is a liveness probe (`text.startsWith('{"ping"')`).
pub fn is_phone_ping(text: &str) -> bool {
    text.starts_with(PHONE_PING_PREFIX)
}

/// The envelope overhead of a client id: the header plus the id's bytes.
pub fn binary_overhead(client_id: &str) -> usize {
    HEADER_BYTES + client_id.len()
}

/// `JSON.stringify({ type: 'frame', clientId, data })`: the text form of a phone frame for a desktop leg that does not take
/// text in the binary envelope. Compact; control characters escape as JavaScript writes them and non-ASCII stays as it is.
pub fn json_frame(client_id: &str, data: &str) -> String {
    let mut out = String::with_capacity(data.len() + client_id.len() + 40);
    out.push_str("{\"type\":\"frame\",\"clientId\":");
    mixdog_js::json_quote(client_id, &mut out);
    out.push_str(",\"data\":");
    mixdog_js::json_quote(data, &mut out);
    out.push('}');
    out
}

/// The byte length of [`json_frame`] with empty data: the fixed part of the wrapper.
pub fn json_frame_overhead(client_id: &str) -> usize {
    json_frame(client_id, "").len()
}
