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

/// A text held once by everything that holds it: a copy is a count, and two fields with the same text (a tool row's `result`
/// and `rawResult`) are one allocation. It reads and writes as the string it is.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct SharedText(std::sync::Arc<str>);

impl SharedText {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Whether the two are one allocation.
    pub fn shares(&self, other: &Self) -> bool {
        std::sync::Arc::ptr_eq(&self.0, &other.0)
    }
}

impl Default for SharedText {
    fn default() -> Self {
        Self(std::sync::Arc::from(""))
    }
}

impl std::ops::Deref for SharedText {
    type Target = str;

    fn deref(&self) -> &str {
        &self.0
    }
}

impl AsRef<str> for SharedText {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for SharedText {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Debug::fmt(&*self.0, f)
    }
}

impl std::fmt::Display for SharedText {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<String> for SharedText {
    fn from(text: String) -> Self {
        Self(text.into())
    }
}

impl From<&str> for SharedText {
    fn from(text: &str) -> Self {
        Self(text.into())
    }
}

impl From<SharedText> for String {
    fn from(text: SharedText) -> Self {
        text.0.as_ref().to_owned()
    }
}

impl PartialEq<str> for SharedText {
    fn eq(&self, other: &str) -> bool {
        &*self.0 == other
    }
}

impl PartialEq<&str> for SharedText {
    fn eq(&self, other: &&str) -> bool {
        &*self.0 == *other
    }
}

impl Serialize for SharedText {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

thread_local! {
    /// The last two texts decoded on this thread, while something still holds them: a tool row states its result up to
    /// three times (`output`, `run.result`, `run.rawResult`), one after the other in its encoding.
    static DECODED: std::cell::RefCell<[std::sync::Weak<str>; 2]> = std::cell::RefCell::new([empty_weak(), empty_weak()]);
}

fn empty_weak() -> std::sync::Weak<str> {
    std::sync::Arc::downgrade(&std::sync::Arc::<str>::from(""))
}

impl SharedText {
    /// A text read from an encoding: the allocation of an equal text decoded just before it on this thread, else its own.
    pub fn decoded(text: &str) -> Self {
        DECODED.with(|decoded| {
            let mut decoded = decoded.borrow_mut();
            if let Some(held) = decoded.iter().filter_map(std::sync::Weak::upgrade).find(|held| **held == *text) {
                return Self(held);
            }
            let own: std::sync::Arc<str> = text.into();
            decoded.swap(0, 1);
            decoded[0] = std::sync::Arc::downgrade(&own);
            Self(own)
        })
    }
}

impl<'de> Deserialize<'de> for SharedText {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Text;

        impl serde::de::Visitor<'_> for Text {
            type Value = SharedText;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a string")
            }

            fn visit_str<E: serde::de::Error>(self, text: &str) -> Result<SharedText, E> {
                Ok(SharedText::decoded(text))
            }
        }

        deserializer.deserialize_str(Text)
    }
}

/// A body that is inline when its encoding is ≤ `INLINE_MAX`, else a blob reference.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(untagged)]
pub enum MaybeBlob<T> {
    Blob(BlobRef),
    Inline(T),
}
