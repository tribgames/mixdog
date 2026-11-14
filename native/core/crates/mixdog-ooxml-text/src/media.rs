//! The text an attached Office file gets when a request is lowered to text (`officeTextForFile` of
//! `media-normalization.mjs`): fixed extraction limits, so the same bytes and file name give the same text on every
//! turn, reload and restart, and a speed cache keyed by the content.
//!
//! CACHE WARNING (Node's): this text is part of every already-sent turn's provider prefix. Changing the extraction, the
//! limits below or the label format changes how old turns lower and invalidates the provider prompt cache of every
//! session that holds such a file.

use std::sync::Mutex;
use std::sync::PoisonError;

use sha2::Digest;
use sha2::Sha256;

use crate::Limits;
use crate::try_extract_ooxml_text_from_buffer;

/// `OFFICE_TEXT_MAX_BYTES`.
pub const OFFICE_TEXT_MAX_BYTES: usize = 256 * 1024;
/// Inflated size caps for lowering: a part or container beyond them has no text form (the fixed description is used),
/// whatever its extractable content.
pub const OFFICE_PART_MAX_BYTES: u64 = 8 * 1024 * 1024;
pub const OFFICE_CONTAINER_MAX_BYTES: u64 = 32 * 1024 * 1024;
/// `MEMO_MAX_ENTRIES`.
const MEMO_MAX_ENTRIES: usize = 64;

/// The remembered extractions, oldest first: a hit moves its entry to the end, an insertion past the bound drops the
/// first (`memoized`). Nothing correctness-related depends on it: a cold memo recomputes the identical text.
static MEMO: Mutex<Vec<(String, Option<String>)>> = Mutex::new(Vec::new());

/// The sextet of a base64 character in either alphabet; 64 and up is not one (Node's `unbase64`).
fn unbase64(c: u8) -> u8 {
    match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' | b'-' => 62,
        b'/' | b'_' => 63,
        _ => 255,
    }
}

/// `Buffer.from(text, 'base64')`: it reads the UTF-16 code units of the string by their low byte, skips a character
/// outside the two alphabets, stops at the first `=`, and a dangling single character carries no byte.
fn node_base64_decode(text: &str) -> Vec<u8> {
    let units: Vec<u8> = text.encode_utf16().map(|unit| unit as u8).collect();
    let mut out = Vec::with_capacity(units.len() / 4 * 3);
    let mut i = 0;
    while i < units.len() {
        let mut hi = 0u8;
        for step in 0..4 {
            let lo = loop {
                let c = units[i];
                i += 1;
                if unbase64(c) < 64 {
                    break unbase64(c);
                }
                if c == b'=' || i >= units.len() {
                    return out;
                }
            };
            match step {
                1 => out.push(((hi & 0x3F) << 2) | ((lo & 0x30) >> 4)),
                2 => out.push(((hi & 0x0F) << 4) | ((lo & 0x3C) >> 2)),
                3 => out.push(((hi & 0x03) << 6) | (lo & 0x3F)),
                _ => {}
            }
            if i >= units.len() {
                return out;
            }
            hi = lo;
        }
    }
    out
}

/// `createHash('sha256').update(filename).update('\0').update(data)`, as hex.
fn memo_key(data_base64: &str, filename: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(filename.as_bytes());
    hash.update([0u8]);
    hash.update(data_base64.as_bytes());
    hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Extracted text, or `None` when the container cannot be read (the caller then uses the plain description).
/// `data_base64` is the file's bytes as Node's `Buffer.from(data, 'base64')` reads them.
pub fn office_text_for_file(data_base64: &str, filename: &str) -> Option<String> {
    let key = memo_key(data_base64, filename);
    {
        let mut memo = MEMO.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(at) = memo.iter().position(|(known, _)| *known == key) {
            let hit = memo.remove(at);
            let text = hit.1.clone();
            memo.push(hit);
            return text;
        }
    }
    let text = try_extract_ooxml_text_from_buffer(
        &node_base64_decode(data_base64),
        filename,
        &Limits {
            max_output_bytes: OFFICE_TEXT_MAX_BYTES,
            max_part_bytes: OFFICE_PART_MAX_BYTES,
            max_container_bytes: OFFICE_CONTAINER_MAX_BYTES,
        },
    );
    let mut memo = MEMO.lock().unwrap_or_else(PoisonError::into_inner);
    // Another caller may have remembered the same file while this one extracted.
    if let Some(at) = memo.iter().position(|(known, _)| *known == key) {
        let known = memo.remove(at);
        memo.push(known);
    } else {
        memo.push((key, text.clone()));
        if memo.len() > MEMO_MAX_ENTRIES {
            memo.remove(0);
        }
    }
    text
}

/// Empties the extraction speed cache (`_clearLoweringMemos`: tests of cold-process equivalence).
pub fn clear_office_text_memo() {
    MEMO.lock().unwrap_or_else(PoisonError::into_inner).clear();
}

/// How many extractions are remembered.
pub fn office_text_memo_len() -> usize {
    MEMO.lock().unwrap_or_else(PoisonError::into_inner).len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_reads_as_buffer_from_does() {
        assert_eq!(node_base64_decode("aGVsbG8="), b"hello");
        assert_eq!(node_base64_decode("aGVsbG8"), b"hello");
        assert_eq!(node_base64_decode("aGVs\nbG8="), b"hello");
        assert_eq!(node_base64_decode("-_-_"), node_base64_decode("+/+/"));
        assert_eq!(node_base64_decode("aGVsbG8=trailing"), b"hello");
        assert_eq!(node_base64_decode(""), b"");
        assert_eq!(node_base64_decode("a"), b"");
    }

    #[test]
    fn the_memo_keeps_the_sixty_four_most_recently_used() {
        // One test owns the global memo: the others of this module do not touch it.
        clear_office_text_memo();
        assert_eq!(office_text_for_file("bm90IGEgemlw", "a.docx"), None);
        assert_eq!(office_text_memo_len(), 1);
        for n in 0..70 {
            let _ = office_text_for_file("bm90IGEgemlw", &format!("f{n}.docx"));
        }
        assert_eq!(office_text_memo_len(), MEMO_MAX_ENTRIES);
        // The oldest was dropped, a hit does not grow the memo.
        let key = memo_key("bm90IGEgemlw", "a.docx");
        assert!(!MEMO.lock().unwrap().iter().any(|(known, _)| *known == key));
        let _ = office_text_for_file("bm90IGEgemlw", "f69.docx");
        assert_eq!(office_text_memo_len(), MEMO_MAX_ENTRIES);
        clear_office_text_memo();
    }
}
