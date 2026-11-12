//! The frame reader as o1 (9ac69bd6d) shipped it, before groups (FORMAT.md §3.6), vendored verbatim as the reference old
//! reader: the downgrade test runs it over logs this tree writes. Test-only; never called by the product.
#![allow(dead_code)]

use crate::crc32c::crc32c;
use crate::schema::frame::*;

const HEX: &[u8; 16] = b"0123456789abcdef";

fn put_hex(out: &mut [u8], value: u64) {
    let digits = out.len();
    for (i, slot) in out.iter_mut().enumerate() {
        let shift = 4 * (digits - 1 - i);
        *slot = HEX[((value >> shift) & 0xf) as usize];
    }
}

/// The 44 header bytes of a frame for `ordinal` and `payload`.
pub fn header(ordinal: u64, payload: &[u8]) -> [u8; HEADER_LEN] {
    let mut h = [SEPARATOR; HEADER_LEN];
    put_hex(&mut h[ORDINAL_AT..ORDINAL_AT + ORDINAL_DIGITS], ordinal);
    put_hex(&mut h[LEN_AT..LEN_AT + LEN_DIGITS], payload.len() as u64);
    put_hex(&mut h[CRC_AT..CRC_AT + CRC_DIGITS], u64::from(crc32c(payload)));
    let hcrc = crc32c(&h[..HCRC_COVERED]);
    put_hex(&mut h[HCRC_AT..HCRC_AT + HCRC_DIGITS], u64::from(hcrc));
    h
}

/// Appends the frame `ordinal`/`payload` to `out`. The payload is a writer encoding
/// (F1: no `0x0A`, no `0x00`) of at most `MAX_FRAME_PAYLOAD` bytes.
pub fn encode_into(out: &mut Vec<u8>, ordinal: u64, payload: &[u8]) {
    debug_assert!(payload.len() <= MAX_FRAME_PAYLOAD);
    debug_assert!(!payload.iter().any(|&b| b == TERMINATOR || b == 0));
    out.extend_from_slice(&header(ordinal, payload));
    out.extend_from_slice(payload);
    out.push(TERMINATOR);
}

fn is_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

fn hex_value(digits: &[u8]) -> u64 {
    digits
        .iter()
        .fold(0, |v, &b| v * 16 + u64::from((b as char).to_digit(16).unwrap_or(0)))
}

/// FORMAT.md §3.2 rule 3 over the present header bytes `h` (1..=44). `Ok(Some(len))` for a
/// complete valid header, `Ok(None)` for a prefix of one the writer can produce for
/// `expected`.
pub fn check_header(h: &[u8], expected: u64) -> Result<Option<usize>, CorruptCause> {
    let field = |at: usize, digits: usize| &h[at.min(h.len())..(at + digits).min(h.len())];
    // 1. hcrc and the final SP.
    let hcrc_present = field(HCRC_AT, HCRC_DIGITS + 1);
    if !hcrc_present.is_empty() {
        let mut want = [SEPARATOR; HCRC_DIGITS + 1];
        put_hex(&mut want[..HCRC_DIGITS], u64::from(crc32c(&h[..HCRC_COVERED])));
        if !want.starts_with(hcrc_present) {
            return Err(CorruptCause::Header);
        }
    }
    // 2. ordinal.
    let mut ordinal = [0u8; ORDINAL_DIGITS];
    put_hex(&mut ordinal, expected);
    if !ordinal.starts_with(field(ORDINAL_AT, ORDINAL_DIGITS)) {
        return Err(CorruptCause::Ordinal);
    }
    // 3. separators 16, 25, 34.
    if SEPARATORS[..3]
        .iter()
        .any(|&at| h.get(at).is_some_and(|&b| b != SEPARATOR))
    {
        return Err(CorruptCause::Header);
    }
    // 4. len: hex digits whose smallest completion is in range.
    let len_digits = field(LEN_AT, LEN_DIGITS);
    if !len_digits.iter().all(|&b| is_hex(b)) {
        return Err(CorruptCause::Length);
    }
    let smallest = hex_value(len_digits) << (4 * (LEN_DIGITS - len_digits.len()));
    if smallest > MAX_FRAME_PAYLOAD as u64 {
        return Err(CorruptCause::Length);
    }
    // 5. crc digits.
    if !field(CRC_AT, CRC_DIGITS).iter().all(|&b| is_hex(b)) {
        return Err(CorruptCause::Crc);
    }
    Ok((h.len() == HEADER_LEN).then_some(smallest as usize))
}

/// The written end of a buffer that extends to end of file: just past its last non-zero
/// byte (FORMAT.md §3.2 `W`).
pub fn written_end(buf: &[u8]) -> usize {
    buf.iter().rposition(|&b| b != 0).map_or(0, |i| i + 1)
}

/// One committed frame found by a scan, at buffer offsets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Committed {
    pub ordinal: u64,
    /// Offset of the frame's first header byte.
    pub start: usize,
    /// Payload length.
    pub len: usize,
}

impl Committed {
    pub fn payload<'a>(&self, buf: &'a [u8]) -> &'a [u8] {
        &buf[self.start + HEADER_LEN..self.start + HEADER_LEN + self.len]
    }

    pub fn frame_len(&self) -> usize {
        self.len + FRAME_OVERHEAD
    }

    pub fn end(&self) -> usize {
        self.start + self.frame_len()
    }
}

/// Result of a forward scan; `ScanEnd` offsets are buffer offsets plus `base`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scan {
    pub frames: Vec<Committed>,
    pub end: ScanEnd,
}

/// Forward scan (FORMAT.md §3.2) of `buf`, which runs to end of file, from frame start
/// `start` with `expected` the ordinal due there. `base` is the file offset of `buf[0]`
/// and is added to the offsets in the returned `ScanEnd`.
pub fn scan(buf: &[u8], base: u64, start: usize, expected: u64) -> Scan {
    let written = written_end(buf);
    let mut frames = Vec::new();
    let mut p = start;
    let mut expected = expected;
    loop {
        let at = base + p as u64;
        let corrupt = |cause, ordinal| ScanEnd::Corrupt {
            offset: at,
            ordinal,
            cause,
        };
        if p == buf.len() {
            return Scan { frames, end: ScanEnd::Clean };
        }
        if written <= p {
            return Scan { frames, end: ScanEnd::Torn { offset: at } };
        }
        let h = &buf[p..written.min(p + HEADER_LEN)];
        let len = match check_header(h, expected) {
            Err(cause) => return Scan { frames, end: corrupt(cause, expected) },
            Ok(None) => return Scan { frames, end: ScanEnd::Torn { offset: at } },
            Ok(Some(len)) => len,
        };
        let payload_end = p + HEADER_LEN + len;
        if payload_end > written {
            return Scan { frames, end: ScanEnd::Torn { offset: at } };
        }
        let crc = hex_value(&h[CRC_AT..CRC_AT + CRC_DIGITS]) as u32;
        if crc32c(&buf[p + HEADER_LEN..payload_end]) != crc {
            return Scan { frames, end: corrupt(CorruptCause::Crc, expected) };
        }
        if payload_end == written {
            return Scan { frames, end: ScanEnd::Torn { offset: at } };
        }
        if buf[payload_end] != TERMINATOR {
            return Scan { frames, end: corrupt(CorruptCause::Framing, expected) };
        }
        frames.push(Committed { ordinal: expected, start: p, len });
        p = payload_end + 1;
        expected += 1;
    }
}

/// Checks one complete frame read by position (`buf` = exactly the frame) and returns its
/// payload, or the cause of damage.
pub fn check_frame(buf: &[u8], ordinal: u64) -> Result<&[u8], CorruptCause> {
    if buf.len() < FRAME_OVERHEAD {
        return Err(CorruptCause::Length);
    }
    let len = match check_header(&buf[..HEADER_LEN], ordinal)? {
        Some(len) => len,
        None => return Err(CorruptCause::Header),
    };
    if len + FRAME_OVERHEAD != buf.len() {
        return Err(CorruptCause::Length);
    }
    let payload = &buf[HEADER_LEN..HEADER_LEN + len];
    if crc32c(payload) != hex_value(&buf[CRC_AT..CRC_AT + CRC_DIGITS]) as u32 {
        return Err(CorruptCause::Crc);
    }
    if buf[buf.len() - 1] != TERMINATOR {
        return Err(CorruptCause::Framing);
    }
    Ok(payload)
}

/// A frame found by the reverse scan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Anchor {
    /// Buffer offset of the frame start.
    pub start: usize,
    pub ordinal: u64,
}

/// Reverse scan (FORMAT.md §3.5) of `buf`, the last bytes of a file through end of file.
/// `buf_is_file_start` says whether `buf[0]` is offset 0 of the file; otherwise a line
/// that begins at `buf[0]` may be cut and is not a candidate. Returns the newest line that
/// is a frame on its own and whose payload starts a `checkpoint` or `session` record.
pub fn reverse_scan(buf: &[u8], buf_is_file_start: bool) -> Option<Anchor> {
    let mut end = written_end(buf);
    // The final line without LF is skipped.
    if end > 0 && buf[end - 1] != TERMINATOR {
        end = buf[..end].iter().rposition(|&b| b == TERMINATOR).map_or(0, |i| i + 1);
    }
    while end > 0 {
        let line_end = end; // one past the LF
        let start = buf[..line_end - 1]
            .iter()
            .rposition(|&b| b == TERMINATOR)
            .map(|i| i + 1);
        let start = match start {
            Some(s) => s,
            None if buf_is_file_start => 0,
            None => return None,
        };
        if let Some(anchor) = anchor_at(&buf[start..line_end], start) {
            return Some(anchor);
        }
        end = start;
    }
    None
}

fn anchor_at(line: &[u8], start: usize) -> Option<Anchor> {
    if line.len() < FRAME_OVERHEAD {
        return None;
    }
    let ordinal_digits = &line[ORDINAL_AT..ORDINAL_AT + ORDINAL_DIGITS];
    if !ordinal_digits.iter().all(|&b| is_hex(b)) {
        return None;
    }
    let ordinal = hex_value(ordinal_digits);
    let payload = check_frame(line, ordinal).ok()?;
    (payload.starts_with(br#"{"k":"checkpoint","#) || payload.starts_with(br#"{"k":"session","#))
        .then_some(Anchor { start, ordinal })
}
