//! Thread-feed frames. A notification's params are encoded once (on cpu-interactive for record
//! bodies, inline for schema-bounded values, in the run task for deltas, RL §5.6); the frame is
//! assembled at publish time by splicing the params between the method and the feed stamp, so
//! seqs are assigned only to frames that are actually published and are contiguous by
//! construction.

use bytes::Bytes;
use mixdog_core_api::ids::FeedEpoch;
use mixdog_core_api::ids::FeedId;
use serde::Serialize;

/// One notification awaiting its seq.
#[derive(Clone, Debug)]
pub(crate) struct Note {
    pub method: &'static str,
    pub params: Bytes,
}

impl Note {
    pub fn new<T: Serialize>(method: &'static str, params: &T) -> Self {
        Self {
            method,
            params: encode(params),
        }
    }
}

/// Compact JSON of a value whose types always serialize.
pub(crate) fn encode<T: Serialize>(value: &T) -> Bytes {
    Bytes::from(serde_json::to_vec(value).expect("protocol types serialize"))
}

/// `{"method":…,"params":…,"feed":{"id":…,"epoch":…,"seq":…}}` (`JsonRpcNotification`).
pub(crate) fn frame(note: &Note, feed: &FeedId, epoch: &FeedEpoch, seq: u64) -> Bytes {
    let mut out = Vec::with_capacity(note.params.len() + note.method.len() + 128);
    out.extend_from_slice(b"{\"method\":");
    serde_json::to_writer(&mut out, note.method).expect("string serializes");
    out.extend_from_slice(b",\"params\":");
    out.extend_from_slice(&note.params);
    out.extend_from_slice(b",\"feed\":{\"id\":");
    serde_json::to_writer(&mut out, feed.as_str()).expect("string serializes");
    out.extend_from_slice(b",\"epoch\":");
    serde_json::to_writer(&mut out, epoch.as_str()).expect("string serializes");
    out.extend_from_slice(b",\"seq\":");
    out.extend_from_slice(seq.to_string().as_bytes());
    out.extend_from_slice(b"}}");
    Bytes::from(out)
}
