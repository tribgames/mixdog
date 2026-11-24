//! Record encoding for the writer (FORMAT.md §4.2, §5.1): body slots by the size rule,
//! `refs`, and the pre-encoded payload a write batch carries. Runs on cpu-interactive
//! (RL §5.6), off the session actor and off the durability lane.

use mixdog_protocol::INLINE_MAX;
use mixdog_protocol::MAX_BLOB_BYTES;
use serde::Serialize;

use crate::blobs::body_blob;
use crate::blobs::digest_of;
use crate::schema::blob::MAX_REFS;
use crate::schema::blob::Slot;
use crate::schema::bounded::Digest;
use crate::schema::frame::MAX_FRAME_PAYLOAD;
use crate::schema::record::Record;
use crate::schema::record::Refs;

#[derive(Debug, thiserror::Error)]
pub enum EncodeError {
    #[error("item too large: {bytes} bytes")]
    ItemTooLarge { bytes: u64 },
    #[error("{count} blob references exceed {MAX_REFS}")]
    TooManyRefs { count: usize },
    #[error("record payload of {bytes} bytes exceeds the frame bound")]
    PayloadTooLarge { bytes: usize },
    #[error("encode: {0}")]
    Json(#[from] serde_json::Error),
}

/// Bytes of an out-of-line body, published before the record that references it.
#[derive(Debug, Clone)]
pub struct PendingBlob {
    pub digest: Digest,
    pub bytes: Vec<u8>,
}

/// `{"inline": value}` when its encoding is ≤ `INLINE_MAX`, else a blob reference whose
/// bytes are that encoding. Size alone decides.
pub fn body_slot<T: Serialize>(value: T) -> Result<(Slot<T>, Option<PendingBlob>), EncodeError> {
    slot_within(value, INLINE_MAX).map(|(slot, blob, _)| (slot, blob))
}

/// The slot rule with `budget` inline bytes (FORMAT.md §4.2): inline when the encoding fits
/// `budget`, else a blob of that encoding. Also returns the inline bytes taken (0 for a
/// blob): an item's `prompt` slot gets the `INLINE_MAX` its inline `body` leaves.
pub fn slot_within<T: Serialize>(value: T, budget: usize) -> Result<(Slot<T>, Option<PendingBlob>, usize), EncodeError> {
    if let Some(len) = encoded_within(&value, budget)? {
        return Ok((Slot::Inline(value), None, len));
    }
    let (slot, blob) = out_of_line(serde_json::to_vec(&value)?)?;
    Ok((slot, Some(blob), 0))
}

/// The encoded length of `value` when it is at most `budget`, measured without keeping the bytes; `None` as soon as it is more.
fn encoded_within<T: Serialize + ?Sized>(value: &T, budget: usize) -> Result<Option<usize>, EncodeError> {
    struct Count {
        len: usize,
        budget: usize,
    }
    impl std::io::Write for Count {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.len += buf.len();
            if self.len > self.budget { Err(std::io::ErrorKind::OutOfMemory.into()) } else { Ok(buf.len()) }
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut count = Count { len: 0, budget };
    match serde_json::to_writer(&mut count, value) {
        Ok(()) => Ok(Some(count.len)),
        Err(error) if error.is_io() && count.len > budget => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// A checkpoint state as it is written: every header value of `HEADER_BLOB_MIN` encoded bytes or more out of line
/// (`CheckpointState::header_blobs`), with the bytes to publish for them. A checkpoint used to hold the whole header each
/// time: 324 KB of tool definitions that never changed in each of one session's 578 checkpoints.
pub fn checkpoint_out_of_line(
    mut state: crate::schema::checkpoint::CheckpointState,
) -> Result<(crate::schema::checkpoint::CheckpointState, Vec<PendingBlob>), EncodeError> {
    let mut blobs = Vec::new();
    for (key, value) in state.header.iter_mut() {
        if value.is_null() || state.header_blobs.contains_key(key) {
            continue;
        }
        let encoded = serde_json::to_vec(value)?;
        if encoded.len() < crate::schema::checkpoint::HEADER_BLOB_MIN {
            continue;
        }
        let (slot, blob) = out_of_line::<serde_json::Value>(encoded)?;
        if let Slot::Blob(held) = slot {
            state.header_blobs.insert(key.clone(), held);
            *value = serde_json::Value::Null;
            blobs.push(blob);
        }
    }
    Ok((state, blobs))
}

/// The state a checkpoint holds, its out-of-line header values read back into their places.
pub fn checkpoint_in_line(
    mut state: crate::schema::checkpoint::CheckpointState,
    resolve: &mut crate::fold::ResolveBody<'_>,
) -> Result<crate::schema::checkpoint::CheckpointState, String> {
    for (key, blob) in std::mem::take(&mut state.header_blobs) {
        let value = serde_json::from_slice(&resolve(&blob)?).map_err(|e| format!("header value {key} of a checkpoint: {e}"))?;
        state.header.insert(key, value);
    }
    Ok(state)
}

/// The blob slot of an encoding that does not stay inline, and the bytes to publish for it.
fn out_of_line<T>(encoded: Vec<u8>) -> Result<(Slot<T>, PendingBlob), EncodeError> {
    if encoded.len() as u64 > MAX_BLOB_BYTES {
        return Err(EncodeError::ItemTooLarge { bytes: encoded.len() as u64 });
    }
    let blob = body_blob(&encoded);
    let digest = blob.descriptor().digest.clone();
    Ok((Slot::Blob(blob), PendingBlob { digest, bytes: encoded }))
}

/// The `RecordCodec` (FORMAT.md §5.1 with the §4.2 slot rule): every inline ★ slot whose
/// encoding exceeds `INLINE_MAX` moves to a blob, an item's `prompt` slot whose encoding
/// exceeds what its inline `body` leaves of `INLINE_MAX` too, and an item's or amend's
/// `refs` gain those blobs' digests. Fails `ItemTooLarge` above `MAX_BLOB_BYTES`.
pub fn encode_record(mut record: Record) -> Result<Encoded, EncodeError> {
    let mut blobs = Vec::new();
    match &mut record {
        Record::Session(r) => drop(reslot(&mut r.header, &mut blobs)?),
        Record::Meta(r) => drop(reslot(&mut r.change, &mut blobs)?),
        Record::Item(r) => {
            let (own, used) = reslot_within(&mut r.body, INLINE_MAX, &mut blobs)?;
            let prompt = match &mut r.prompt {
                Some(prompt) => reslot_within(prompt, INLINE_MAX - used, &mut blobs)?.0,
                None => None,
            };
            if own.is_some() || prompt.is_some() {
                r.refs = refs(r.refs.as_slice().iter().cloned(), own.into_iter().chain(prompt))?;
            }
        }
        Record::Amend(r) => {
            if let Some(own) = reslot(&mut r.body, &mut blobs)? {
                r.refs = refs(r.refs.as_slice().iter().cloned(), Some(own))?;
            }
        }
        Record::Compacted(r) => {
            drop(reslot(&mut r.replacement, &mut blobs)?);
        }
        Record::Run(r) => reslot_opt(&mut r.detail, &mut blobs)?,
        Record::Approval(r) => reslot_opt(&mut r.body, &mut blobs)?,
        Record::Queue(r) => reslot_opt(&mut r.entry, &mut blobs)?,
        Record::Op(r) => reslot_opt(&mut r.detail, &mut blobs)?,
        Record::Checkpoint(r) => {
            if let Slot::Inline(state) = &mut r.state {
                let (kept, large) = checkpoint_out_of_line(state.clone())?;
                *state = kept;
                blobs.extend(large);
            }
            drop(reslot(&mut r.state, &mut blobs)?);
        }
        Record::ModelSwitch(r) => drop(reslot(&mut r.entry, &mut blobs)?),
        Record::Draft(r) => drop(reslot(&mut r.body, &mut blobs)?),
        Record::WorkStop(r) => reslot_opt(&mut r.body, &mut blobs)?,
        Record::Rewind(_) => {}
    }
    Encoded::new(record, blobs)
}

fn reslot<T: Serialize>(slot: &mut Slot<T>, blobs: &mut Vec<PendingBlob>) -> Result<Option<Digest>, EncodeError> {
    Ok(reslot_within(slot, INLINE_MAX, blobs)?.0)
}

/// `slot_within` over an inline slot, in place: a value that fits stays where it is, and one that does not is replaced by
/// its blob slot, whose bytes go to `blobs` and whose digest is returned. A slot already out of line takes no inline bytes.
fn reslot_within<T: Serialize>(slot: &mut Slot<T>, budget: usize, blobs: &mut Vec<PendingBlob>) -> Result<(Option<Digest>, usize), EncodeError> {
    let Slot::Inline(value) = slot else {
        return Ok((None, 0));
    };
    if let Some(len) = encoded_within(value, budget)? {
        return Ok((None, len));
    }
    let (moved, blob) = out_of_line(serde_json::to_vec(value)?)?;
    let digest = blob.digest.clone();
    *slot = moved;
    blobs.push(blob);
    Ok((Some(digest), 0))
}

fn reslot_opt<T: Serialize>(slot: &mut Option<Slot<T>>, blobs: &mut Vec<PendingBlob>) -> Result<(), EncodeError> {
    if let Some(slot) = slot {
        reslot(slot, blobs)?;
    }
    Ok(())
}

/// Sorted, unique `refs`: the attachment digests of a body plus the record's own slot
/// blobs (an item's body and prompt).
pub fn refs(attachments: impl IntoIterator<Item = Digest>, own: impl IntoIterator<Item = Digest>) -> Result<Refs, EncodeError> {
    let mut all: Vec<Digest> = attachments.into_iter().collect();
    all.extend(own);
    all.sort();
    all.dedup();
    let count = all.len();
    Refs::try_from(all).map_err(|_| EncodeError::TooManyRefs { count })
}

/// One record ready for a write batch: the typed record (for the fold and the projection),
/// its payload bytes and the blobs it references out of line.
#[derive(Debug, Clone)]
pub struct Encoded {
    pub(crate) record: Record,
    pub(crate) payload: Vec<u8>,
    pub(crate) blobs: Vec<PendingBlob>,
}

impl Encoded {
    /// `blobs` are the out-of-line bodies returned by `body_slot` for this record.
    pub fn new(record: Record, blobs: Vec<PendingBlob>) -> Result<Self, EncodeError> {
        let payload = serde_json::to_vec(&record)?;
        if payload.len() > MAX_FRAME_PAYLOAD {
            return Err(EncodeError::PayloadTooLarge { bytes: payload.len() });
        }
        debug_assert!(blobs.iter().all(|b| digest_of(&b.bytes) == b.digest));
        Ok(Self { record, payload, blobs })
    }

    /// A record encoded earlier by `encode_record` (its payload and blobs carried apart,
    /// e.g. through `mixdog-core`'s `CommitRecord`).
    pub fn from_parts(record: Record, payload: Vec<u8>, blobs: Vec<PendingBlob>) -> Self {
        debug_assert_eq!(serde_json::to_vec(&record).ok().as_deref(), Some(payload.as_slice()));
        Self { record, payload, blobs }
    }

    pub fn record(&self) -> &Record {
        &self.record
    }

    /// FORMAT.md §5.1 payload bytes.
    pub fn payload(&self) -> &[u8] {
        &self.payload
    }

    /// The out-of-line bodies, published before the record's barrier.
    pub fn blobs(&self) -> &[PendingBlob] {
        &self.blobs
    }

    /// Frame bytes this record takes in a batch.
    pub fn frame_len(&self) -> usize {
        self.payload.len() + crate::schema::frame::FRAME_OVERHEAD
    }
}
