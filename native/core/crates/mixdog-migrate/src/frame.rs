//! Frame encoding and the forward scan of FORMAT.md §2–§3.2, for the migration journal
//! and the staged session logs. Same layout and rules as the store's frame codec
//! (checked against `mixdog-store`'s `frames.json` vectors), used here until WP-STORE's
//! codec lands.

use std::ops::Range;

use mixdog_store::schema::frame::CRC_AT;
use mixdog_store::schema::frame::CRC_DIGITS;
use mixdog_store::schema::frame::CorruptCause;
use mixdog_store::schema::frame::HCRC_AT;
use mixdog_store::schema::frame::HCRC_COVERED;
use mixdog_store::schema::frame::HCRC_DIGITS;
use mixdog_store::schema::frame::HEADER_LEN;
use mixdog_store::schema::frame::LEN_AT;
use mixdog_store::schema::frame::LEN_DIGITS;
use mixdog_store::schema::frame::MAX_FRAME_PAYLOAD;
use mixdog_store::schema::frame::ORDINAL_AT;
use mixdog_store::schema::frame::ORDINAL_DIGITS;
use mixdog_store::schema::frame::SEPARATOR;
use mixdog_store::schema::frame::SEPARATORS;
use mixdog_store::schema::frame::ScanEnd;
use mixdog_store::schema::frame::TERMINATOR;

const fn crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut crc = i as u32;
        let mut bit = 0;
        while bit < 8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ mixdog_store::schema::frame::CRC32C_POLY_REFLECTED
            } else {
                crc >> 1
            };
            bit += 1;
        }
        table[i] = crc;
        i += 1;
    }
    table
}

static CRC_TABLE: [u32; 256] = crc_table();

pub fn crc32c(data: &[u8]) -> u32 {
    let mut crc = u32::MAX;
    for &b in data {
        crc = CRC_TABLE[((crc ^ u32::from(b)) & 0xFF) as usize] ^ (crc >> 8);
    }
    !crc
}

/// Appends one frame (`45 + payload.len()` bytes) to `out`.
pub fn encode_into(out: &mut Vec<u8>, ordinal: u64, payload: &[u8]) {
    debug_assert!(payload.len() <= MAX_FRAME_PAYLOAD);
    let start = out.len();
    out.extend_from_slice(
        format!(
            "{ordinal:016x} {:08x} {:08x} ",
            payload.len(),
            crc32c(payload)
        )
        .as_bytes(),
    );
    let hcrc = crc32c(&out[start..start + HCRC_COVERED]);
    out.extend_from_slice(format!("{hcrc:08x} ").as_bytes());
    out.extend_from_slice(payload);
    out.push(TERMINATOR);
}

pub fn encode(ordinal: u64, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + HEADER_LEN + 1);
    encode_into(&mut out, ordinal, payload);
    out
}

fn is_hex(b: u8) -> bool {
    b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
}

/// Rule 3 over the present header bytes `h`: `Ok(Some(len))` for a complete valid header,
/// `Ok(None)` for a prefix of one the writer could produce for `expected`.
fn check_header(h: &[u8], expected: u64) -> Result<Option<usize>, CorruptCause> {
    let field = |at: usize, digits: usize| &h[at.min(h.len())..(at + digits).min(h.len())];
    let hcrc = format!("{:08x} ", crc32c(&h[..HCRC_COVERED.min(h.len())]));
    if !hcrc.as_bytes().starts_with(field(HCRC_AT, HCRC_DIGITS + 1)) {
        return Err(CorruptCause::Header);
    }
    if !format!("{expected:016x}")
        .as_bytes()
        .starts_with(field(ORDINAL_AT, ORDINAL_DIGITS))
    {
        return Err(CorruptCause::Ordinal);
    }
    if SEPARATORS[..3]
        .iter()
        .any(|&at| h.get(at).is_some_and(|&b| b != SEPARATOR))
    {
        return Err(CorruptCause::Header);
    }
    let len_digits = field(LEN_AT, LEN_DIGITS);
    if !len_digits.iter().all(|&b| is_hex(b)) {
        return Err(CorruptCause::Length);
    }
    let smallest = len_digits
        .iter()
        .chain(std::iter::repeat(&b'0'))
        .take(LEN_DIGITS)
        .fold(0usize, |v, &b| v * 16 + (b as char).to_digit(16).unwrap_or(0) as usize);
    if smallest > MAX_FRAME_PAYLOAD {
        return Err(CorruptCause::Length);
    }
    if !field(CRC_AT, CRC_DIGITS).iter().all(|&b| is_hex(b)) {
        return Err(CorruptCause::Crc);
    }
    Ok((h.len() == HEADER_LEN).then_some(smallest))
}

/// One committed frame found by `scan`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Committed {
    pub ordinal: u64,
    /// Byte offset of the frame in the scanned buffer.
    pub offset: usize,
    pub payload: Range<usize>,
}

/// Forward scan from offset 0 with `start_ordinal` due there (FORMAT.md §3.2, rules in
/// order): the committed frames and how the scan ended.
pub fn scan(buf: &[u8], start_ordinal: u64) -> (Vec<Committed>, ScanEnd) {
    let written = buf.iter().rposition(|&b| b != 0).map_or(0, |i| i + 1);
    let mut committed = Vec::new();
    let mut p = 0;
    let mut expected = start_ordinal;
    loop {
        let torn = ScanEnd::Torn { offset: p as u64 };
        let corrupt = |cause| ScanEnd::Corrupt {
            offset: p as u64,
            ordinal: expected,
            cause,
        };
        if p == buf.len() {
            return (committed, ScanEnd::Clean);
        }
        if written <= p {
            return (committed, torn);
        }
        let h = &buf[p..written.min(p + HEADER_LEN)];
        let len = match check_header(h, expected) {
            Err(cause) => return (committed, corrupt(cause)),
            Ok(None) => return (committed, torn),
            Ok(Some(len)) => len,
        };
        let payload_end = p + HEADER_LEN + len;
        if payload_end > written {
            return (committed, torn);
        }
        if h[CRC_AT..CRC_AT + CRC_DIGITS]
            != *format!("{:08x}", crc32c(&buf[p + HEADER_LEN..payload_end])).as_bytes()
        {
            return (committed, corrupt(CorruptCause::Crc));
        }
        if payload_end == written {
            return (committed, torn);
        }
        if buf[payload_end] != TERMINATOR {
            return (committed, corrupt(CorruptCause::Framing));
        }
        committed.push(Committed {
            ordinal: expected,
            offset: p,
            payload: p + HEADER_LEN..payload_end,
        });
        p = payload_end + 1;
        expected += 1;
    }
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
