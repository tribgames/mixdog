//! Out-of-line bodies (SPEC R2): one inline bound and one reference shape for
//! disk, wire and sections.

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

use crate::BlobDigest;

/// Every body above this many encoded bytes is a blob reference (`INLINE_MAX`, SPEC R2).
pub const INLINE_MAX: usize = 256 * 1024;

/// Largest blob the store accepts (1.4.5 attachment input limit, SPEC §6.2).
pub const MAX_BLOB_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
/// Server-produced and embedded in store records, which parse it strictly.
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlobDescriptor {
    pub digest: BlobDigest,
    #[ts(type = "number")]
    pub bytes: u64,
    pub media_type: String,
}

/// `{"blob":{"digest":"sha256:…","bytes":n,"mediaType":"…"}}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
pub struct BlobRef {
    pub blob: BlobDescriptor,
}

/// A body that is inline when its encoding is ≤ `INLINE_MAX`, else a blob reference.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(untagged)]
pub enum MaybeBlob<T> {
    Blob(BlobRef),
    Inline(T),
}
