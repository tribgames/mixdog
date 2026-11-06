//! `payloadDigest` (P §9.2): `sha256` of the canonical JSON of a mutation's params without
//! `opId` — object keys in byte order, no whitespace — hashed while it is written, with no
//! intermediate buffer.

use std::fmt::Write as _;
use std::io::Write;
use std::sync::Arc;

use serde_json::Value;
use sha2::Digest as _;
use sha2::Sha256;

/// `sha256:<64 lowercase hex>` of a mutation's params.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct PayloadDigest(Arc<str>);

impl PayloadDigest {
    /// Digests `params`, leaving out its top-level `opId`.
    pub fn of_params(params: &Value) -> Self {
        let mut hasher = Sha256::new();
        match params {
            Value::Object(map) => write_object(&mut hasher, map, Some("opId")),
            other => write_canonical(&mut hasher, other),
        }
        let mut text = String::with_capacity(7 + 64);
        text.push_str("sha256:");
        for byte in hasher.finalize() {
            let _ = write!(text, "{byte:02x}");
        }
        Self(text.into())
    }

    /// A stored digest, as read back by an op store.
    pub fn from_stored(text: Arc<str>) -> Self {
        Self(text)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn write_canonical(out: &mut Sha256, value: &Value) {
    match value {
        Value::Object(map) => write_object(out, map, None),
        Value::Array(items) => {
            out.update(b"[");
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.update(b",");
                }
                write_canonical(out, item);
            }
            out.update(b"]");
        }
        scalar => {
            serde_json::to_writer(HashWriter(out), scalar).expect("a JSON scalar always serializes")
        }
    }
}

fn write_object(out: &mut Sha256, map: &serde_json::Map<String, Value>, skip: Option<&str>) {
    let mut keys: Vec<&String> = map.keys().filter(|k| Some(k.as_str()) != skip).collect();
    keys.sort_unstable();
    out.update(b"{");
    for (i, key) in keys.into_iter().enumerate() {
        if i > 0 {
            out.update(b",");
        }
        serde_json::to_writer(HashWriter(out), key).expect("a string always serializes");
        out.update(b":");
        write_canonical(out, &map[key]);
    }
    out.update(b"}");
}

struct HashWriter<'a>(&'a mut Sha256);

impl Write for HashWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.update(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
