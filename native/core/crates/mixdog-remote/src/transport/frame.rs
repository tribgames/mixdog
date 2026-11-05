//! Record framing for both carriers (`encodeRemoteTransportRecord`, `decodeRemoteTransportMessage`).
//! Framing is unauthenticated on purpose: it only decides what reaches E2EE decryption.

use super::consts::{
    BOX_HEADER_BYTES, CHUNK_BYTES, CHUNK_HEADER_BYTES, GCM_TAG_BYTES, MAX_CONTROL_BOX_BYTES, MAX_MESSAGE_BYTES,
    MAX_RECORD_BYTES, PREFIX_BYTES,
};
use super::TransportError;

const TRANSPORT_MAGIC: [u8; 4] = [0x4d, 0x58, 0x54, 0x01]; // 'MXT' v1
const BOX_MAGIC: [u8; 4] = [0x4d, 0x58, 0x45, 0x01]; // an application box
const CONTROL_MAGIC: [u8; 4] = [0x4d, 0x58, 0x43, 0x01]; // a control box
const KIND_APP: u8 = 1;
const KIND_CHUNK: u8 = 2;
const KIND_CONTROL: u8 = 3;
const MIN_BOX_BYTES: usize = BOX_HEADER_BYTES + GCM_TAG_BYTES;
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// An application record's carrier message: a whole box or one chunk of it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecordMessage {
    App { sequence: u64, box_bytes: Vec<u8> },
    Chunk { sequence: u64, index: u32, count: u32, total: u32, data: Vec<u8> },
}

impl RecordMessage {
    pub fn sequence(&self) -> u64 {
        match self {
            Self::App { sequence, .. } | Self::Chunk { sequence, .. } => *sequence,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Message {
    Record(RecordMessage),
    Control { box_bytes: Vec<u8> },
}

/// The sequence an application box carries in its header.
pub fn box_sequence(box_bytes: &[u8]) -> Result<u64, TransportError> {
    if box_bytes.len() < MIN_BOX_BYTES || box_bytes[..4] != BOX_MAGIC {
        return Err(TransportError::invalid("application box"));
    }
    let raw = u64::from_be_bytes(box_bytes[4..12].try_into().expect("8 bytes"));
    if !(1..=MAX_SAFE_INTEGER).contains(&raw) {
        return Err(TransportError::invalid("application sequence"));
    }
    Ok(raw)
}

fn prefixed(kind: u8, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(PREFIX_BYTES + body.len());
    out.extend_from_slice(&TRANSPORT_MAGIC);
    out.push(kind);
    out.extend_from_slice(body);
    out
}

/// The carrier messages for one application box: whole when it fits one chunk, otherwise
/// fixed-size chunks. The same bytes on every carrier.
pub fn encode_record(box_bytes: &[u8]) -> Result<Vec<Vec<u8>>, TransportError> {
    let sequence = box_sequence(box_bytes)?;
    if box_bytes.len() > MAX_RECORD_BYTES {
        return Err(TransportError::invalid("record size"));
    }
    if box_bytes.len() <= CHUNK_BYTES {
        return Ok(vec![prefixed(KIND_APP, box_bytes)]);
    }
    let count = box_bytes.len().div_ceil(CHUNK_BYTES);
    Ok(box_bytes
        .chunks(CHUNK_BYTES)
        .enumerate()
        .map(|(index, data)| {
            let mut out = Vec::with_capacity(CHUNK_HEADER_BYTES + data.len());
            out.extend_from_slice(&TRANSPORT_MAGIC);
            out.push(KIND_CHUNK);
            out.extend_from_slice(&sequence.to_be_bytes());
            out.extend_from_slice(&(index as u32).to_be_bytes());
            out.extend_from_slice(&(count as u32).to_be_bytes());
            out.extend_from_slice(&(box_bytes.len() as u32).to_be_bytes());
            out.extend_from_slice(data);
            out
        })
        .collect())
}

/// The carrier message for one sealed control box.
pub fn encode_control(box_bytes: &[u8]) -> Result<Vec<u8>, TransportError> {
    if box_bytes.len() < MIN_BOX_BYTES || box_bytes[..4] != CONTROL_MAGIC {
        return Err(TransportError::invalid("control box"));
    }
    if box_bytes.len() > MAX_CONTROL_BOX_BYTES {
        return Err(TransportError::invalid("control size"));
    }
    Ok(prefixed(KIND_CONTROL, box_bytes))
}

/// Strict decoder for one carrier message; refuses anything a conforming peer cannot produce.
pub fn decode_message(bytes: &[u8]) -> Result<Message, TransportError> {
    if bytes.len() > MAX_MESSAGE_BYTES || bytes.len() < PREFIX_BYTES {
        return Err(TransportError::invalid("message size"));
    }
    if bytes[..4] != TRANSPORT_MAGIC {
        return Err(TransportError::invalid("message magic"));
    }
    let body = &bytes[PREFIX_BYTES..];
    match bytes[4] {
        KIND_APP => {
            if body.len() > CHUNK_BYTES {
                return Err(TransportError::invalid("record size"));
            }
            Ok(Message::Record(RecordMessage::App { sequence: box_sequence(body)?, box_bytes: body.to_vec() }))
        }
        KIND_CONTROL => {
            if body.len() < MIN_BOX_BYTES || body[..4] != CONTROL_MAGIC {
                return Err(TransportError::invalid("control box"));
            }
            Ok(Message::Control { box_bytes: body.to_vec() })
        }
        KIND_CHUNK => {
            if bytes.len() < CHUNK_HEADER_BYTES {
                return Err(TransportError::invalid("chunk header"));
            }
            let sequence = u64::from_be_bytes(bytes[5..13].try_into().expect("8 bytes"));
            if !(1..=MAX_SAFE_INTEGER).contains(&sequence) {
                return Err(TransportError::invalid("chunk sequence"));
            }
            let word = |at: usize| u32::from_be_bytes(bytes[at..at + 4].try_into().expect("4 bytes"));
            let (index, count, total) = (word(13), word(17), word(21));
            if total as usize <= CHUNK_BYTES || total as usize > MAX_RECORD_BYTES {
                return Err(TransportError::invalid("chunk total"));
            }
            if count as usize != (total as usize).div_ceil(CHUNK_BYTES) || index >= count {
                return Err(TransportError::invalid("chunk index"));
            }
            let expected = if index == count - 1 {
                total as usize - index as usize * CHUNK_BYTES
            } else {
                CHUNK_BYTES
            };
            let data = &bytes[CHUNK_HEADER_BYTES..];
            if data.len() != expected {
                return Err(TransportError::invalid("chunk length"));
            }
            Ok(Message::Record(RecordMessage::Chunk { sequence, index, count, total, data: data.to_vec() }))
        }
        _ => Err(TransportError::invalid("message kind")),
    }
}
