//! Out-of-line bodies (SPEC R2): one inline bound and one reference shape for
//! disk, wire and sections.

use serde::Deserialize;
use serde::Serialize;

use crate::BlobDigest;

/// Every body above this many encoded bytes is a blob reference (`INLINE_MAX`, SPEC R2).
pub const INLINE_MAX: usize = 256 * 1024;

/// Largest blob the store accepts (1.4.5 attachment input limit, SPEC §6.2).
pub const MAX_BLOB_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
/// Server-produced and embedded in store records, which parse it strictly.
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlobDescriptor {
    pub digest: BlobDigest,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub bytes: u64,
    pub media_type: String,
}

/// `{"blob":{"digest":"sha256:…","bytes":n,"mediaType":"…"}}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct BlobRef {
    pub blob: BlobDescriptor,
}

/// A body that is inline when its encoding is ≤ `INLINE_MAX`, else a blob reference.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(untagged)]
pub enum MaybeBlob<T> {
    Blob(BlobRef),
    Inline(T),
}
