//! Frame codec and reader rules (FORMAT.md §2–§3): encoding, the §3.2 forward-scan
//! classification and the §3.5 reverse scan. Pure functions over bytes; the callers do
//! the I/O.

pub use crate::crc32c::crc32c;
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

/// Forward scan (FORMAT.md §3.2, §3.6) of `buf`, which runs to end of file, from frame start
/// `start` with `expected` the ordinal due there. `base` is the file offset of `buf[0]`
/// and is added to the offsets in the returned `ScanEnd`. A group is validated whole (its marker,
/// its members' bytes against the marker's length and SHA-256, every member frame, their count)
/// before any member is returned: a group whose bytes run past the written end is a torn tail at
/// its marker; any other failure is damage at its marker. No member of a group that fails is
/// returned.
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
        let len = match read_frame(buf, written, p, expected) {
            Frame::Torn => return Scan { frames, end: ScanEnd::Torn { offset: at } },
            Frame::Corrupt(cause) => return Scan { frames, end: corrupt(cause, expected) },
            Frame::Committed(len) => len,
        };
        let next = p + len + FRAME_OVERHEAD;
        match parse_group_marker(&buf[p + HEADER_LEN..p + HEADER_LEN + len]) {
            Err(cause) => return Scan { frames, end: corrupt(cause, expected) },
            Ok(None) => {
                frames.push(Committed { ordinal: expected, start: p, len });
                p = next;
                expected += 1;
            }
            Ok(Some(marker)) => {
                let end = match usize::try_from(marker.bytes).ok().and_then(|bytes| next.checked_add(bytes)) {
                    Some(end) if end <= written => end,
                    // The group's bytes are not all written: the write was cut, the group is the torn tail.
                    _ => return Scan { frames, end: ScanEnd::Torn { offset: at } },
                };
                match group_members(buf, next, end, &marker, expected) {
                    Ok(members) => {
                        expected += members.len() as u64;
                        frames.extend(members);
                        p = end;
                    }
                    Err(cause) => return Scan { frames, end: corrupt(cause, expected) },
                }
            }
        }
    }
}

/// How one frame at `p` reads (§3.2 rules over the bytes up to `written`).
enum Frame {
    Committed(usize),
    Torn,
    Corrupt(CorruptCause),
}

fn read_frame(buf: &[u8], written: usize, p: usize, expected: u64) -> Frame {
    if written <= p {
        return Frame::Torn;
    }
    let h = &buf[p..written.min(p + HEADER_LEN)];
    let len = match check_header(h, expected) {
        Err(cause) => return Frame::Corrupt(cause),
        Ok(None) => return Frame::Torn,
        Ok(Some(len)) => len,
    };
    let payload_end = p + HEADER_LEN + len;
    if payload_end > written {
        return Frame::Torn;
    }
    let crc = hex_value(&h[CRC_AT..CRC_AT + CRC_DIGITS]) as u32;
    if crc32c(&buf[p + HEADER_LEN..payload_end]) != crc {
        return Frame::Corrupt(CorruptCause::Crc);
    }
    if payload_end == written {
        return Frame::Torn;
    }
    if buf[payload_end] != TERMINATOR {
        return Frame::Corrupt(CorruptCause::Framing);
    }
    Frame::Committed(len)
}

/// The member frames of the group whose marker is `marker` and whose members are `buf[start..end]`, the first due at
/// `expected`, all of them or the cause the group fails: bytes other than the marker names, a member that is not a whole
/// frame inside the group, a member that is itself a marker or an anchor (`checkpoint`/`session`: no anchor is ever
/// inside a group), or a count other than the marker's.
fn group_members(buf: &[u8], start: usize, end: usize, marker: &GroupMarker, expected: u64) -> Result<Vec<Committed>, CorruptCause> {
    if !group_matches(marker, &buf[start..end]) {
        return Err(CorruptCause::Framing);
    }
    let group = &buf[..end];
    let mut members = Vec::new();
    let mut q = start;
    let mut ordinal = expected;
    while q < end {
        let len = match read_frame(group, end, q, ordinal) {
            Frame::Committed(len) => len,
            Frame::Torn => return Err(CorruptCause::Framing),
            Frame::Corrupt(cause) => return Err(cause),
        };
        let payload = &group[q + HEADER_LEN..q + HEADER_LEN + len];
        if !matches!(parse_group_marker(payload), Ok(None)) || is_anchor(payload) {
            return Err(CorruptCause::Framing);
        }
        members.push(Committed { ordinal, start: q, len });
        q += len + FRAME_OVERHEAD;
        ordinal += 1;
    }
    if members.len() as u64 != marker.count {
        return Err(CorruptCause::Framing);
    }
    Ok(members)
}

fn is_anchor(payload: &[u8]) -> bool {
    payload.starts_with(br#"{"k":"checkpoint","#) || payload.starts_with(br#"{"k":"session","#)
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
        let start = line_start(buf, end, buf_is_file_start)?;
        if let Some(anchor) = anchor_at(&buf[start..end], start) {
            // An anchor inside the extent of a group marker before it is never the writer's (§3.6): the search goes on
            // before that marker, whose group the forward scan then validates.
            match covering_marker(buf, start, buf_is_file_start) {
                Some(marker) => {
                    end = marker;
                    continue;
                }
                None => return Some(anchor),
            }
        }
        end = start;
    }
    None
}

/// Start of the line that ends (LF included) at `end`; `None` when it may be cut by the window.
fn line_start(buf: &[u8], end: usize, buf_is_file_start: bool) -> Option<usize> {
    match buf[..end - 1].iter().rposition(|&b| b == TERMINATOR) {
        Some(i) => Some(i + 1),
        None if buf_is_file_start => Some(0),
        None => None,
    }
}

/// The start of a group marker line before `at` within `buf` whose members' extent holds `at`.
fn covering_marker(buf: &[u8], at: usize, buf_is_file_start: bool) -> Option<usize> {
    let mut end = at;
    while end > 0 {
        let start = line_start(buf, end, buf_is_file_start)?;
        let line = &buf[start..end];
        if line.len() >= FRAME_OVERHEAD && line[ORDINAL_AT..ORDINAL_AT + ORDINAL_DIGITS].iter().all(|&b| is_hex(b)) {
            let ordinal = hex_value(&line[ORDINAL_AT..ORDINAL_AT + ORDINAL_DIGITS]);
            if let Ok(payload) = check_frame(line, ordinal)
                && let Ok(Some(marker)) = parse_group_marker(payload)
                && (at as u64) < end as u64 + marker.bytes
            {
                return Some(start);
            }
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
    is_anchor(payload).then_some(Anchor { start, ordinal })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

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
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
            .collect()
    }

    fn doc() -> Doc {
        serde_json::from_str(mixdog_testkit::fixture!("src/schema/vectors/frames.json")).expect("frames.json")
    }

    #[test]
    fn encodes_every_single_vector() {
        for single in doc().single {
            let mut out = Vec::new();
            encode_into(&mut out, single.ordinal, single.payload.as_bytes());
            assert_eq!(out, unhex(&single.hex));
        }
    }

    #[test]
    fn classifies_every_vector_of_the_table() {
        for case in doc().classification {
            let bytes = unhex(&case.hex);
            let got = scan(&bytes, 0, 0, case.start_ordinal);
            assert_eq!(
                (got.frames.len(), got.end),
                (case.expect.committed, case.expect.end),
                "{}",
                case.name
            );
            // The same verdict from a non-zero base offset and frame start.
            let mut shifted = vec![b'x'; 7];
            shifted.extend_from_slice(&bytes);
            let moved = scan(&shifted, 100, 7, case.start_ordinal);
            let shift = |end: ScanEnd| match end {
                ScanEnd::Clean => ScanEnd::Clean,
                ScanEnd::Torn { offset } => ScanEnd::Torn { offset: offset + 107 },
                ScanEnd::Corrupt { offset, ordinal, cause } => ScanEnd::Corrupt {
                    offset: offset + 107,
                    ordinal,
                    cause,
                },
            };
            assert_eq!(moved.end, shift(got.end), "{}", case.name);
        }
    }

    #[test]
    fn reverse_scan_finds_the_newest_checkpoint_and_passes_over_damage() {
        let mut buf = Vec::new();
        encode_into(&mut buf, 0, br#"{"k":"session","v":2}"#);
        encode_into(&mut buf, 1, br#"{"k":"meta"}"#);
        let cp = buf.len();
        encode_into(&mut buf, 2, br#"{"k":"checkpoint","state":{}}"#);
        encode_into(&mut buf, 3, br#"{"k":"meta"}"#);
        // A damaged checkpoint line, then a torn tail and zeros.
        let mut bad = Vec::new();
        encode_into(&mut bad, 4, br#"{"k":"checkpoint","state":{}}"#);
        bad[50] ^= 1;
        buf.extend_from_slice(&bad);
        buf.extend_from_slice(b"0000000000000005 0000");
        buf.extend_from_slice(&[0; 64]);
        assert_eq!(reverse_scan(&buf, true), Some(Anchor { start: cp, ordinal: 2 }));
        assert_eq!(reverse_scan(&buf[..cp], true), Some(Anchor { start: 0, ordinal: 0 }));
        // A window that cuts the session line: it is not a candidate.
        assert_eq!(reverse_scan(&buf[1..cp], false), None);
    }
}
