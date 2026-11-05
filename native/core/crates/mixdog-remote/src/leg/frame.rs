//! Wire forms on the desktop leg: the relay's binary routing frame (`relay-binary-frame.mjs`)
//! and the JSON envelopes. The relay forwards payloads verbatim and parses none of them.

use serde_json::Value;

const MAGIC: [u8; 4] = [0x4d, 0x58, 0x52, 0x01];
pub const HEADER_BYTES: usize = 6;
const FLAG_DROPPABLE: u8 = 1;
const FLAG_TEXT: u8 = 2;

/// `^[0-9a-f-]{8,64}$`
pub fn is_routing_id(value: &str) -> bool {
    (8..=64).contains(&value.len()) && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'-'))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Payload {
    Text(String),
    Binary(Vec<u8>),
}

impl Payload {
    pub fn len(&self) -> usize {
        match self {
            Self::Text(text) => text.len(),
            Self::Binary(bytes) => bytes.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn as_bytes(&self) -> &[u8] {
        match self {
            Self::Text(text) => text.as_bytes(),
            Self::Binary(bytes) => bytes,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BinaryFrame {
    pub client_id: String,
    pub droppable: bool,
    pub payload: Payload,
}

/// `None` when the id is not 1..=64 bytes (the relay refuses it as well).
pub fn encode_binary_frame(client_id: &str, data: &[u8], droppable: bool, text: bool) -> Option<Vec<u8>> {
    let id = client_id.as_bytes();
    if id.is_empty() || id.len() > 64 {
        return None;
    }
    let mut frame = Vec::with_capacity(HEADER_BYTES + id.len() + data.len());
    frame.extend_from_slice(&MAGIC);
    frame.push(if droppable { FLAG_DROPPABLE } else { 0 } | if text { FLAG_TEXT } else { 0 });
    frame.push(id.len() as u8);
    frame.extend_from_slice(id);
    frame.extend_from_slice(data);
    Some(frame)
}

/// A text-flagged frame carries UTF-8 that is handed on as a string; an old frame has no flag
/// and stays bytes. A frame that is neither well-formed nor valid text is dropped.
pub fn decode_binary_frame(raw: &[u8]) -> Option<BinaryFrame> {
    if raw.len() < HEADER_BYTES + 1 || raw[..4] != MAGIC {
        return None;
    }
    let id_len = usize::from(raw[5]);
    if !(1..=64).contains(&id_len) || raw.len() < HEADER_BYTES + id_len {
        return None;
    }
    let client_id = std::str::from_utf8(&raw[HEADER_BYTES..HEADER_BYTES + id_len]).ok()?;
    if !is_routing_id(client_id) {
        return None;
    }
    let data = &raw[HEADER_BYTES + id_len..];
    let payload = if raw[4] & FLAG_TEXT != 0 {
        Payload::Text(String::from_utf8_lossy(data).into_owned())
    } else {
        Payload::Binary(data.to_vec())
    };
    Some(BinaryFrame { client_id: client_id.to_owned(), droppable: raw[4] & FLAG_DROPPABLE != 0, payload })
}

/// The JSON form of a phone frame, for a relay that does not echo binary framing.
pub fn json_frame(client_id: &str, data: &str) -> Value {
    serde_json::json!({ "type": "frame", "clientId": client_id, "data": data })
}
