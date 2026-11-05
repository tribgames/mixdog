//! Application messages above the record layer (`splitRemoteTransportPayload`,
//! `RemoteTransportMessageAssembler`): a payload larger than one record travels as consecutive
//! fragment payloads, each sealed as its own record.

use std::sync::{Arc, Mutex, PoisonError};

use base64::Engine;
use base64::alphabet::URL_SAFE;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use serde_json::Value;

use super::consts::{
    ASSEMBLY_IDLE_MS, ASSEMBLY_POOL_BYTES, FRAGMENT_BYTES, MAX_APPLICATION_MESSAGE_BYTES, MAX_FRAGMENTS,
    MAX_RECORD_PLAINTEXT_BYTES,
};
use super::TransportError;

pub const FRAGMENT_TYPE: &str = "transport-fragment";

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// URL-safe base64 without padding, tolerant of non-canonical trailing bits like `atob`.
const URL_NO_PAD: GeneralPurpose = GeneralPurpose::new(
    &URL_SAFE,
    GeneralPurposeConfig::new().with_encode_padding(false).with_decode_padding_mode(DecodePaddingMode::RequireNone).with_decode_allow_trailing_bits(true),
);

fn base64_decode(value: &str, what: &str) -> Result<Vec<u8>, TransportError> {
    let alphabet = !value.is_empty() && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !alphabet || value.len() % 4 == 1 {
        return Err(TransportError::invalid(what));
    }
    URL_NO_PAD.decode(value).map_err(|_| TransportError::invalid(what))
}

/// The payloads to seal for one application message, given as its JSON text: the text itself
/// when it fits one record, otherwise its fragments under `id` (unique per session and
/// direction). Refuses BEFORE anything is sealed when the message exceeds the relay's frame
/// ceiling, so a refusal never consumes a sequence.
pub fn split_payload(text: &str, id: u64) -> Result<Vec<String>, TransportError> {
    let bytes = text.as_bytes();
    if bytes.len() <= MAX_RECORD_PLAINTEXT_BYTES {
        return Ok(vec![text.to_owned()]);
    }
    if bytes.len() > MAX_APPLICATION_MESSAGE_BYTES {
        return Err(TransportError::invalid("message size"));
    }
    if id < 1 || id > MAX_SAFE_INTEGER {
        return Err(TransportError::invalid("fragment id"));
    }
    let count = bytes.len().div_ceil(FRAGMENT_BYTES);
    Ok(bytes
        .chunks(FRAGMENT_BYTES)
        .enumerate()
        .map(|(index, part)| {
            let data = URL_NO_PAD.encode(part);
            format!(r#"{{"type":"{FRAGMENT_TYPE}","id":{id},"index":{index},"count":{count},"data":"{data}"}}"#)
        })
        .collect())
}

/// Process-wide accounting of large-message assembly in serialized bytes. Cloning shares it.
#[derive(Clone, Debug)]
pub struct AssemblyPool {
    inner: Arc<Mutex<(usize, usize)>>,
}

impl Default for AssemblyPool {
    fn default() -> Self {
        Self::new(ASSEMBLY_POOL_BYTES)
    }
}

impl AssemblyPool {
    pub fn new(capacity: usize) -> Self {
        Self { inner: Arc::new(Mutex::new((0, capacity))) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, (usize, usize)> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn try_reserve(&self, bytes: usize) -> bool {
        let mut state = self.lock();
        if state.0 + bytes > state.1 {
            return false;
        }
        state.0 += bytes;
        true
    }

    pub fn release(&self, bytes: usize) {
        let mut state = self.lock();
        state.0 = state.0.saturating_sub(bytes);
    }

    pub fn used_bytes(&self) -> usize {
        self.lock().0
    }
}

/// What `accept` made of one opened payload.
#[derive(Debug, PartialEq, Eq)]
pub enum Assembly {
    /// A whole message: its JSON bytes, byte for byte as sent.
    Complete(Vec<u8>),
    /// A fragment was kept; more are coming.
    Partial,
    /// The first fragment of a large message found the pool full. Nothing was kept: the caller
    /// holds this payload and offers it again later, pulling no further record meanwhile.
    Wait,
}

struct Partial {
    id: u64,
    count: u64,
    next: u64,
    parts: Vec<Vec<u8>>,
    bytes: usize,
    at: u64,
}

/// Turns the opened, in-order record payloads of ONE session back into application messages with
/// relay-equivalent serialized-bytes semantics (one large message at a time, reserved from the
/// pool at its first fragment, released on completion, failure or `close`).
pub struct MessageAssembler {
    pool: AssemblyPool,
    partial: Option<Partial>,
    reserved: usize,
}

impl MessageAssembler {
    pub fn new(pool: AssemblyPool) -> Self {
        Self { pool, partial: None, reserved: 0 }
    }

    pub fn accept(&mut self, plaintext: &[u8], now: u64) -> Result<Assembly, TransportError> {
        let value: Value = serde_json::from_slice(plaintext).map_err(|_| TransportError::invalid("payload"))?;
        let is_fragment = value.get("type").and_then(Value::as_str) == Some(FRAGMENT_TYPE);
        if !is_fragment {
            if self.partial.is_some() {
                return Err(TransportError::invalid("message interleaved with a fragmented one"));
            }
            return Ok(Assembly::Complete(plaintext.to_vec()));
        }
        let number = |key: &str, what: &str| {
            value.get(key).and_then(Value::as_u64).filter(|n| (1..=MAX_SAFE_INTEGER).contains(n)).ok_or_else(|| TransportError::invalid(what))
        };
        let id = number("id", "fragment id")?;
        let count = number("count", "fragment count")?;
        if count < 2 || count as usize > MAX_FRAGMENTS {
            return Err(TransportError::invalid("fragment count"));
        }
        let index = value.get("index").and_then(Value::as_u64).ok_or_else(|| TransportError::invalid("fragment index"))?;
        let data = value
            .get("data")
            .and_then(Value::as_str)
            .filter(|data| data.len() <= (FRAGMENT_BYTES * 4).div_ceil(3))
            .ok_or_else(|| TransportError::invalid("fragment data"))?;
        if self.partial.is_none() {
            if index != 0 {
                return Err(TransportError::invalid("fragment order"));
            }
            let declared = count as usize * FRAGMENT_BYTES;
            if !self.pool.try_reserve(declared) {
                return Ok(Assembly::Wait);
            }
            self.reserved = declared;
            self.partial = Some(Partial { id, count, next: 0, parts: Vec::new(), bytes: 0, at: now });
        }
        match self.accept_fragment(id, count, index, data, now) {
            Ok(done) => Ok(done),
            Err(error) => {
                self.close();
                Err(error)
            }
        }
    }

    fn accept_fragment(&mut self, id: u64, count: u64, index: u64, data: &str, now: u64) -> Result<Assembly, TransportError> {
        let partial = self.partial.as_mut().expect("partial set above");
        if partial.id != id || partial.count != count || index != partial.next {
            return Err(TransportError::invalid("fragment order"));
        }
        let bytes = base64_decode(data, "fragment data")?;
        let last = partial.next == count - 1;
        if if last { bytes.is_empty() } else { bytes.len() != FRAGMENT_BYTES } {
            return Err(TransportError::invalid("fragment length"));
        }
        partial.bytes += bytes.len();
        partial.parts.push(bytes);
        partial.next += 1;
        partial.at = now;
        if !last {
            return Ok(Assembly::Partial);
        }
        let done = self.partial.take().expect("partial set above");
        if done.bytes <= MAX_RECORD_PLAINTEXT_BYTES {
            return Err(TransportError::invalid("fragmented message size"));
        }
        if done.bytes > MAX_APPLICATION_MESSAGE_BYTES {
            return Err(TransportError::invalid("message size"));
        }
        let whole = done.parts.concat();
        self.free();
        serde_json::from_slice::<Value>(&whole).map_err(|_| TransportError::invalid("payload"))?;
        Ok(Assembly::Complete(whole))
    }

    /// A large message is assembling but got no fragment for `ASSEMBLY_IDLE_MS`: end the session.
    pub fn stalled(&self, now: u64) -> bool {
        self.partial.as_ref().is_some_and(|partial| now.saturating_sub(partial.at) >= ASSEMBLY_IDLE_MS)
    }

    /// The session ended: drop the partial message and free its reservation.
    pub fn close(&mut self) {
        self.partial = None;
        self.free();
    }

    fn free(&mut self) {
        self.pool.release(self.reserved);
        self.reserved = 0;
    }

    pub fn pending_bytes(&self) -> usize {
        self.partial.as_ref().map_or(0, |partial| partial.bytes)
    }

    pub fn reserved_bytes(&self) -> usize {
        self.reserved
    }
}
