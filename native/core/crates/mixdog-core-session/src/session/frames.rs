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
        Self { method, params: encode(params) }
    }
}

/// Compact JSON of a value whose types always serialize.
pub(crate) fn encode<T: Serialize>(value: &T) -> Bytes {
    Bytes::from(serde_json::to_vec(value).expect("protocol types serialize"))
}

/// `{"method":…,"params":…,"feed":{"id":…,"epoch":…,"seq":…}}` (`JsonRpcNotification`).
pub(crate) fn frame(note: &Note, feed: &FeedId, epoch: &FeedEpoch, seq: u64) -> Bytes {
    // The frame's own length: a buffer that has to grow doubles, and the frame then holds twice its bytes for as long as
    // a ring or a lane keeps it (a thread's feed id and epoch alone are longer than a fixed allowance).
    const PUNCTUATION_AND_SEQ: usize = 100;
    let mut out = Vec::with_capacity(note.params.len() + note.method.len() + feed.as_str().len() + epoch.as_str().len() + PUNCTUATION_AND_SEQ);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_holds_its_own_bytes_and_not_a_buffer_twice_their_size() {
        let params = serde_json::json!({ "output": "x".repeat(200_000) });
        let note = Note::new("item/completed", &params);
        let feed = FeedId::from(format!("sess_12345_1795292148156_1795292154294_{}", "a".repeat(32)));
        let epoch = FeedEpoch::from("0193b2f2-7c1e-7d5a-9d0e-5f3c2a1b4c6d".to_owned());
        let framed = frame(&note, &feed, &epoch, u64::MAX);
        let value: serde_json::Value = serde_json::from_slice(&framed).unwrap();
        assert_eq!((value["method"].clone(), value["feed"]["seq"].clone()), (serde_json::json!("item/completed"), serde_json::json!(u64::MAX)));
        assert_eq!(value["params"], params);
        assert_eq!(value["feed"]["id"], feed.as_str());
        let length = framed.len();
        // Taking the frame's buffer back shows what it holds.
        let held = Vec::from(framed).capacity();
        assert!(held < length + 256, "a frame of {length} bytes holds a buffer of {held}");
    }
}
