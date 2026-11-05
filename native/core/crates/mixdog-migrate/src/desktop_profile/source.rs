//! Reading profile sources the way the desktop's own readers do (BOM stripped), on top
//! of the migration's JSON helpers: lone surrogates, canonical digests.

use mixdog_store::schema::bounded::Digest;
use mixdog_store::schema::migration::QuarantineCode;
use mixdog_store::schema::migration::SourceFile;
use serde_json::Value;

use super::error::ApplyError;
use super::error::Step;
use crate::framework::ItemContext;
use crate::json;

pub(super) use crate::json::Parsed;

/// A converted source above this size is `item_too_large`; the largest real file is the
/// 1.3 MB session metadata.
pub(super) const MAX_CONVERTED_BYTES: u64 = 64 * 1024 * 1024;

/// `root/a/b` from a manifest `/`-separated relative path.
pub(super) fn resolve(root: &std::path::Path, relative: &str) -> std::path::PathBuf {
    relative.split('/').fold(root.to_path_buf(), |path, part| path.join(part))
}

/// The digest of a value's canonical JSON.
pub(super) fn digest_value(value: &Value) -> Digest {
    Digest::try_from(json::digest_of(value)).expect("sha256: and 64 lowercase hex")
}

/// The digest `sha256:<hex>` of a hash already computed.
pub(super) fn digest_of_hash(hash: &str) -> Digest {
    Digest::try_from(format!("sha256:{hash}")).expect("sha256: and 64 lowercase hex")
}

/// Compact JSON with object keys sorted at every level.
pub(super) fn canonical_text(value: &Value) -> String {
    serde_json::to_string(&json::canonical(value)).expect("a Value always encodes")
}

/// The bytes of a converted source, still hashing to the manifest's value.
pub(super) fn read_source(cx: &ItemContext<'_>, file: &SourceFile) -> Step<Vec<u8>> {
    if file.size > MAX_CONVERTED_BYTES {
        return Err(ApplyError::quarantine(
            QuarantineCode::ItemTooLarge,
            format!("{} is {} bytes", file.path, file.size),
        ));
    }
    Ok(cx.read_source(file)?)
}

pub(super) fn parse_json(bytes: &[u8]) -> Step<Parsed> {
    std::str::from_utf8(bytes)
        .map_err(|_| ApplyError::quarantine(QuarantineCode::ParseError, "not UTF-8"))?;
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    json::parse_source(bytes)
        .map_err(|error| ApplyError::quarantine(QuarantineCode::ParseError, format!("not JSON: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bom_is_stripped_and_garbage_is_a_parse_error() {
        assert!(parse_json(b"\xef\xbb\xbf{\"a\":1}").is_ok());
        let Err(ApplyError::Quarantine(failure)) = parse_json(b"{\"a\":") else {
            panic!("expected quarantine");
        };
        assert_eq!(failure.code, QuarantineCode::ParseError);
    }

    #[test]
    fn digests_ignore_key_order() {
        let a: Value = serde_json::from_str(r#"{"b":1,"a":[{"z":1,"y":2}]}"#).unwrap();
        let b: Value = serde_json::from_str(r#"{"a":[{"y":2,"z":1}],"b":1}"#).unwrap();
        assert_eq!(digest_value(&a), digest_value(&b));
        assert_eq!(canonical_text(&a), r#"{"a":[{"y":2,"z":1}],"b":1}"#);
    }
}
