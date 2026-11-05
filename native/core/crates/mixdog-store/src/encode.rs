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
    let encoded = serde_json::to_vec(&value)?;
    if encoded.len() <= budget {
        return Ok((Slot::Inline(value), None, encoded.len()));
    }
    if encoded.len() as u64 > MAX_BLOB_BYTES {
        return Err(EncodeError::ItemTooLarge { bytes: encoded.len() as u64 });
    }
    let blob = body_blob(&encoded);
    let digest = blob.descriptor().digest.clone();
    Ok((Slot::Blob(blob), Some(PendingBlob { digest, bytes: encoded }), 0))
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
                r.refs = refs(r.refs.as_slice().iter().cloned(), own.iter().chain(&prompt))?;
            }
        }
        Record::Amend(r) => {
            if let Some(own) = reslot(&mut r.body, &mut blobs)? {
                r.refs = refs(r.refs.as_slice().iter().cloned(), Some(&own))?;
            }
        }
        Record::Compacted(r) => {
            drop(reslot(&mut r.replacement, &mut blobs)?);        }
        Record::Run(r) => reslot_opt(&mut r.detail, &mut blobs)?,
        Record::Approval(r) => reslot_opt(&mut r.body, &mut blobs)?,
        Record::Queue(r) => reslot_opt(&mut r.entry, &mut blobs)?,
        Record::Op(r) => reslot_opt(&mut r.detail, &mut blobs)?,
        Record::Checkpoint(r) => drop(reslot(&mut r.state, &mut blobs)?),
        Record::Rewind(_) => {}
    }
    Encoded::new(record, blobs)
}

fn reslot<T: Serialize + Clone>(slot: &mut Slot<T>, blobs: &mut Vec<PendingBlob>) -> Result<Option<PendingBlob>, EncodeError> {
    Ok(reslot_within(slot, INLINE_MAX, blobs)?.0)
}

/// `slot_within` over an inline slot; a slot already out of line takes no inline bytes.
fn reslot_within<T: Serialize + Clone>(
    slot: &mut Slot<T>,
    budget: usize,
    blobs: &mut Vec<PendingBlob>,
) -> Result<(Option<PendingBlob>, usize), EncodeError> {
    let Slot::Inline(value) = slot else {
        return Ok((None, 0));
    };
    let (moved, blob, used) = slot_within(value.clone(), budget)?;
    *slot = moved;
    blobs.extend(blob.clone());
    Ok((blob, used))
}

fn reslot_opt<T: Serialize + Clone>(slot: &mut Option<Slot<T>>, blobs: &mut Vec<PendingBlob>) -> Result<(), EncodeError> {
    if let Some(slot) = slot {
        reslot(slot, blobs)?;
    }
    Ok(())
}

/// Sorted, unique `refs`: the attachment digests of a body plus the record's own slot
/// blobs (an item's body and prompt).
pub fn refs<'a>(
    attachments: impl IntoIterator<Item = Digest>,
    own: impl IntoIterator<Item = &'a PendingBlob>,
) -> Result<Refs, EncodeError> {
    let mut all: Vec<Digest> = attachments.into_iter().collect();
    all.extend(own.into_iter().map(|b| b.digest.clone()));
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
