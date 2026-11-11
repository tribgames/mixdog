//! Frame encoding and the forward scan of FORMAT.md §2–§3.6, for the migration journal and the staged session logs:
//! the store's own codec and reader (`mixdog_store::framing`), so the two cannot drift; this module only keeps the
//! shape the migration reads (byte offsets and payload ranges).

use std::ops::Range;

use mixdog_store::schema::frame::FRAME_OVERHEAD;
use mixdog_store::schema::frame::HEADER_LEN;
use mixdog_store::schema::frame::ScanEnd;

/// CRC-32C (the frame checksum), from the store.
pub fn crc32c(data: &[u8]) -> u32 {
    mixdog_store::framing::crc32c(data)
}

/// Appends one frame (`45 + payload.len()` bytes) to `out`.
pub fn encode_into(out: &mut Vec<u8>, ordinal: u64, payload: &[u8]) {
    mixdog_store::framing::encode_into(out, ordinal, payload);
}

pub fn encode(ordinal: u64, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + FRAME_OVERHEAD);
    encode_into(&mut out, ordinal, payload);
    out
}

/// One committed frame found by `scan`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Committed {
    pub ordinal: u64,
    /// Byte offset of the frame in the scanned buffer.
    pub offset: usize,
    pub payload: Range<usize>,
}

/// Forward scan from offset 0 with `start_ordinal` due there: the store's reader (`mixdog_store::framing::scan`, groups
/// included), its committed frames and how it ended.
pub fn scan(buf: &[u8], start_ordinal: u64) -> (Vec<Committed>, ScanEnd) {
    let scan = mixdog_store::framing::scan(buf, 0, 0, start_ordinal);
    let committed = scan
        .frames
        .iter()
        .map(|frame| Committed { ordinal: frame.ordinal, offset: frame.start, payload: frame.start + HEADER_LEN..frame.start + HEADER_LEN + frame.len })
        .collect();
    (committed, scan.end)
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "the test reads its vector file with std::fs")]
mod tests {
    use serde::Deserialize;

    use super::*;

    #[derive(Deserialize)]
    struct Doc {
        single: Vec<Single>,
        classification: Vec<Case>,
    }

    #[derive(Deserialize)]
    struct Single {
        ordinal: u64,
        payload: String,
        hex: String,
    }

    #[derive(Deserialize)]
    struct Case {
        name: String,
        start_ordinal: u64,
        hex: String,
        expect: Expect,
    }

    #[derive(Deserialize)]
    struct Expect {
        committed: usize,
        end: ScanEnd,
    }

    fn unhex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
            .collect()
    }

    fn doc() -> Doc {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../mixdog-store/src/schema/vectors/frames.json"
        );
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    #[test]
    fn crc_check_value() {
        assert_eq!(
            crc32c(b"123456789"),
            mixdog_store::schema::frame::CRC32C_CHECK
        );
    }

    #[test]
    fn encodes_the_store_vectors() {
        for single in doc().single {
            assert_eq!(
                encode(single.ordinal, single.payload.as_bytes()),
                unhex(&single.hex)
            );
        }
    }

    #[test]
    fn classifies_every_store_vector() {
        for case in doc().classification {
            let (committed, end) = scan(&unhex(&case.hex), case.start_ordinal);
            assert_eq!(
                (committed.len(), end),
                (case.expect.committed, case.expect.end),
                "{}",
                case.name
            );
        }
    }
}
