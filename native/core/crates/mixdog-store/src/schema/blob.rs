//! Record body slots (FORMAT.md §4). `INLINE_MAX`, `MAX_BLOB_BYTES` and the blob
//! descriptor are `mixdog-protocol`'s; only the on-disk slot tag is the store's.

use mixdog_protocol::BlobDescriptor;
use serde::Deserialize;
use serde::Serialize;
use serde::Serializer;

use super::bounded::Digest;

/// Digest text form, everywhere a digest is written: `sha256:` + 64 lowercase hex.
pub const DIGEST_PREFIX: &str = "sha256:";
/// Blob files live at `<D>/prompt-attachments/sha256/<first two hex>/<64 hex>`.
pub const BLOB_DIR: &str = "prompt-attachments/sha256";
/// Media type of an out-of-line body slot (its bytes are the slot value's `serde_json` encoding).
pub const BODY_MEDIA_TYPE: &str = "application/json";
/// Most digests one record's `refs` may list (64 attachments per message in 1.4.5,
/// headroom for an amended body).
pub const MAX_REFS: usize = 128;

/// A record's body slot: `{"inline": <value>}` or
/// `{"blob":{"digest":"sha256:<hex>","bytes":n,"mediaType":"…"}}`, whose `blob` value is the
/// protocol descriptor (SPEC R2). The tag makes an inline value that happens to look like
/// a reference unambiguous.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Slot<T> {
    Inline(T),
    Blob(BodyBlob),
}

/// The protocol descriptor of an out-of-line body: a well-formed digest and
/// `mediaType` = `BODY_MEDIA_TYPE`, so its encoding is bounded.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(try_from = "BlobDescriptor")]
pub struct BodyBlob(BlobDescriptor);

impl BodyBlob {
    pub fn descriptor(&self) -> &BlobDescriptor {
        &self.0
    }
}

impl TryFrom<BlobDescriptor> for BodyBlob {
    type Error = String;

    fn try_from(value: BlobDescriptor) -> Result<Self, Self::Error> {
        if !Digest::is_valid(value.digest.as_str()) {
            return Err(format!("not a sha256 digest: {:?}", value.digest.as_str()));
        }
        if value.media_type != BODY_MEDIA_TYPE {
            return Err(format!("body blob media type {:?}", value.media_type));
        }
        Ok(Self(value))
    }
}

impl Serialize for BodyBlob {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}
