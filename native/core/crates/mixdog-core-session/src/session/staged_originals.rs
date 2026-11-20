//! Originals staged ahead of a message (`thread/stageAttachmentOriginal`): a composer that resized an image for the model
//! hands the file as picked over first, and the message that follows names it (`originalRef`).
//!
//! A stage only publishes the bytes in the shared blob store. Nothing deletes a blob in this release (mixdog-store
//! FORMAT.md §4.3), so staged bytes need no hold, and no bookkeeping decides what a message holds: a message keeps every
//! original whose bytes are in the store when it is accepted ([`drop_missing`]), however often it is retried, from
//! whichever window, and whether or not the same bytes were staged or sent before.

use std::path::Path;

use mixdog_app_protocol::v2::thread::TurnInput;
use mixdog_rt::InLane;
use mixdog_statefile::IoLane;
use mixdog_store::blobs::BlobError;
use mixdog_store::blobs::BlobStore;
use mixdog_store::blobs::digest_of_reference;
use serde_json::Value;

/// The sentence a failed stage answers.
pub type StageError = String;

pub struct StagedOriginals {
    blobs: BlobStore,
}

impl StagedOriginals {
    pub fn new(data_dir: &Path) -> Self {
        Self { blobs: BlobStore::new(data_dir) }
    }

    /// A stage: the bytes published, their attachment ref answered. Fails when the bytes are empty or over the per-file
    /// limit, or the store cannot be written.
    pub fn stage<L: IoLane>(&self, lane: &InLane<L>, bytes: &[u8]) -> Result<String, StageError> {
        if bytes.is_empty() {
            return Err("staged original is empty".into());
        }
        match self.blobs.put_with(lane, bytes, mixdog_store::fsio::Access::Inherit) {
            Ok(digest) => Ok(mixdog_store::blobs::hex(&digest).to_owned()),
            Err(BlobError::ItemTooLarge { .. }) => Err("prompt attachment exceeds the 64 MiB input limit".to_owned()),
            Err(other) => Err(other.to_string()),
        }
    }

    /// Whether the bytes `reference` names are in the store. A failure to look other than their absence counts as there:
    /// the message then keeps the reference, which is what it was sent with.
    pub fn stored<L: IoLane>(&self, lane: &InLane<L>, reference: &str) -> bool {
        let Some(digest) = digest_of_reference(reference) else { return false };
        !matches!(self.blobs.len(lane, &digest), Ok(None))
    }
}

/// The refs the originals of a message's pasted images name (`originalRef` of each of `input.options.pastedImages`), in
/// order; an image naming none contributes nothing.
pub fn named_originals(params: &Value) -> Vec<String> {
    pasted_images(params)
        .into_iter()
        .flat_map(|images| images.values())
        .filter_map(|image| image.get("originalRef").and_then(Value::as_str).filter(|r| !r.is_empty()).map(str::to_owned))
        .collect()
}

fn pasted_images(params: &Value) -> Option<&serde_json::Map<String, Value>> {
    params.pointer("/input/options/pastedImages").and_then(Value::as_object)
}

/// Where the core keeps the originals a submission named that were not in the store when it was accepted: on the
/// `turn/start` params the handle passes the actor (whatever a caller put there is replaced), and on the queue entry the
/// message waits as. The submission itself is kept as it was sent, so an entry taken back to its composer is sent again as
/// it was, and accepted again like any other send.
pub const MISSING_KEY: &str = "missingOriginals";

/// The originals `value` (params or a queue entry) records as missing ([`MISSING_KEY`]).
pub fn missing_of(value: &Value) -> Vec<String> {
    value.get(MISSING_KEY).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
}

/// Records `missing` on `value` under [`MISSING_KEY`], or nothing when none is.
pub fn record_missing(value: &mut Value, missing: &[String]) {
    if let Some(object) = value.as_object_mut() {
        object.shift_remove(MISSING_KEY);
        if !missing.is_empty() {
            object.insert(MISSING_KEY.into(), Value::from(missing.to_vec()));
        }
    }
}

/// The message as it is built from a submission: an image whose original `missing` names keeps only its resized copy, the
/// original's ref and media type gone; every other image is left as it is. Answers how many images lost theirs: the count
/// the message records (`originalImagesMissing`), from which every surface words its note.
pub fn drop_missing(input: &mut TurnInput, missing: &[String]) -> u32 {
    let Some(images) = input.options.as_mut().and_then(|options| options.pasted_images.as_mut()) else { return 0 };
    let mut lost = 0;
    for image in images.values_mut() {
        if image.original_ref.as_ref().is_some_and(|original| missing.contains(original)) {
            image.original_ref = None;
            image.original_media_type = None;
            lost += 1;
        }
    }
    lost
}

/// How many images of the queue entry `entry` go with only their smaller copy ([`drop_missing`] of its submission).
pub fn lost_in_entry(entry: &Value) -> u32 {
    let missing = missing_of(entry);
    entry
        .pointer("/options/pastedImages")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|images| images.values())
        .filter(|image| image.get("originalRef").and_then(Value::as_str).is_some_and(|original| missing.iter().any(|m| m == original)))
        .count() as u32
}
