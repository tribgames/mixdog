//! The bytes of one side of a change, and the rules that decide whether they are text.

use mixdog_core_api::turn_review::ReviewContent;

/// Text of one change side: `""` when absent, `None` for binary content (not UTF-8, or holding a
/// NUL byte) and for a side whose bytes were not captured. Node `decodeText` (fatal UTF-8, BOM
/// kept).
pub fn decode_text(content: &ReviewContent) -> Option<&str> {
    match content {
        ReviewContent::Absent => Some(""),
        ReviewContent::Bytes(bytes) => {
            let text = std::str::from_utf8(bytes).ok()?;
            if text.contains('\0') { None } else { Some(text) }
        }
        ReviewContent::Omitted { .. } => None,
    }
}

/// True for bytes that get a binary patch instead of a text diff (not UTF-8, or holding a NUL
/// byte); an omitted side counts too, as in Node (its decode throws).
pub fn is_binary_change_content(content: &ReviewContent) -> bool {
    !matches!(content, ReviewContent::Absent) && decode_text(content).is_none()
}

pub fn is_omitted(content: &ReviewContent) -> bool {
    matches!(content, ReviewContent::Omitted { .. })
}

pub fn is_absent(content: &ReviewContent) -> bool {
    matches!(content, ReviewContent::Absent)
}

/// The bytes a side holds; nothing for an absent or omitted one.
pub fn content_len(content: &ReviewContent) -> usize {
    match content {
        ReviewContent::Bytes(bytes) => bytes.len(),
        _ => 0,
    }
}

/// `sameContent`: absent equals only absent, an omitted side equals nothing, bytes by value.
pub fn same_content(left: &ReviewContent, right: &ReviewContent) -> bool {
    match (left, right) {
        (ReviewContent::Absent, ReviewContent::Absent) => true,
        (ReviewContent::Absent, _) | (_, ReviewContent::Absent) => false,
        (ReviewContent::Omitted { .. }, _) | (_, ReviewContent::Omitted { .. }) => false,
        (ReviewContent::Bytes(a), ReviewContent::Bytes(b)) => a == b,
    }
}

/// `text.toString('utf8')`: invalid sequences become U+FFFD.
pub fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// The bytes of a side for hashing (the line differ's cache key); `None` for absent/omitted.
pub fn raw_bytes(content: &ReviewContent) -> Option<&[u8]> {
    match content {
        ReviewContent::Bytes(bytes) => Some(bytes),
        _ => None,
    }
}
