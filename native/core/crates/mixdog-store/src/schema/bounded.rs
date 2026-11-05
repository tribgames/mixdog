//! Bounded field types (FORMAT.md §3.3). Every non-body field of a record has one of
//! these types (or a fixed-size scalar), so the largest encoded record, and with it
//! `MAX_FRAME_PAYLOAD`, follows from the types. Parsing refuses an out-of-bound value.

use std::io;

use serde::Deserialize;
use serde::Serialize;
use serde::Serializer;
use serde_json::Value;

/// Ids: sessions, items, runs, approvals, queue entries, compactions, archive segments,
/// clients.
pub const ID_MAX: usize = 256;
/// Short names: roles, op methods, provider/model/account/route/preset/effort.
pub const NAME_MAX: usize = 128;
/// Op ids (client UUIDv7, 36 bytes).
pub const OP_ID_MAX: usize = 64;
/// `log_id`: 24 lowercase hex.
pub const LOG_ID_MAX: usize = 24;
/// A bare SHA-256: 64 lowercase hex.
pub const SHA256_HEX_MAX: usize = 64;
/// Migration item keys (`retain/<root>/<path>` carries a relative path).
pub const ITEM_KEY_MAX: usize = 4096;
/// Encoded bytes of an inline `OpRef.result` (P §9.2).
pub const OP_RESULT_MAX: usize = 16 * 1024;

/// Text of at most `MAX` UTF-8 bytes. Its JSON encoding is at most `6·MAX + 2` bytes
/// (every byte a `\u00XX` escape, plus the quotes).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Deserialize)]
#[serde(try_from = "String")]
pub struct Text<const MAX: usize>(String);

impl<const MAX: usize> Text<MAX> {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<const MAX: usize> TryFrom<String> for Text<MAX> {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.len() <= MAX {
            Ok(Self(value))
        } else {
            Err(format!("text of {} bytes exceeds {MAX}", value.len()))
        }
    }
}

impl<const MAX: usize> TryFrom<&str> for Text<MAX> {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Self::try_from(value.to_owned())
    }
}

impl<const MAX: usize> Serialize for Text<MAX> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

pub type Id = Text<ID_MAX>;
pub type Name = Text<NAME_MAX>;

/// At most `MAX` elements.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(try_from = "Vec<T>", bound(deserialize = "T: Deserialize<'de>"))]
pub struct List<T, const MAX: usize>(Vec<T>);

impl<T, const MAX: usize> List<T, MAX> {
    pub fn as_slice(&self) -> &[T] {
        &self.0
    }
}

impl<T, const MAX: usize> TryFrom<Vec<T>> for List<T, MAX> {
    type Error = String;

    fn try_from(value: Vec<T>) -> Result<Self, Self::Error> {
        if value.len() <= MAX {
            Ok(Self(value))
        } else {
            Err(format!("list of {} elements exceeds {MAX}", value.len()))
        }
    }
}

impl<T: Serialize, const MAX: usize> Serialize for List<T, MAX> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

/// `sha256:` + 64 lowercase hex; always 73 encoded bytes. The one digest type of the
/// codebase: the protocol's, which validates the format wherever it is parsed or built.
pub type Digest = mixdog_protocol::BlobDigest;

/// A JSON value whose encoding is at most `MAX` bytes.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(try_from = "Value")]
pub struct Json<const MAX: usize>(Value);

impl<const MAX: usize> Json<MAX> {
    pub fn get(&self) -> &Value {
        &self.0
    }
}

/// Counts encoded bytes without buffering them.
struct Count(usize);

impl io::Write for Count {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0 += buf.len();
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Bytes of the compact JSON encoding of `value`.
pub fn encoded_len<T: Serialize>(value: &T) -> usize {
    let mut count = Count(0);
    serde_json::to_writer(&mut count, value).expect("encoding to a counter cannot fail");
    count.0
}

impl<const MAX: usize> TryFrom<Value> for Json<MAX> {
    type Error = String;

    fn try_from(value: Value) -> Result<Self, Self::Error> {
        let len = encoded_len(&value);
        if len <= MAX {
            Ok(Self(value))
        } else {
            Err(format!("value of {len} encoded bytes exceeds {MAX}"))
        }
    }
}

impl<const MAX: usize> Serialize for Json<MAX> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}
