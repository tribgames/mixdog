//! Console output encoding for native Windows programs (`tools/shell-codepage.mjs`). Legacy
//! programs write in the system OEM code page (CP949 on a Korean install); reading that as UTF-8
//! garbles it. The encoding is decided PER STREAM: leading ASCII needs no decision; from the first
//! non-ASCII byte a window (to the 16th non-ASCII byte or 4096 bytes) that is strictly valid
//! UTF-8 means UTF-8, anything else the OEM page; the choice is committed and one stateful decoder
//! decodes the rest. Supported OEM pages are the DBCS pages 932/936/949/950 and the exactly
//! mapped single-byte pages 866, 874 and 1250–1258; others stay UTF-8. No effect off Windows
//! (the host passes `None`).

use encoding_rs::Decoder;
use encoding_rs::Encoding;

/// A WHATWG encoding label.
pub type Label = &'static str;

const NON_ASCII_DECISION_BYTES: usize = 16;
pub(super) const WINDOW_CAP: usize = 4096;
const SCAN_CHUNK: usize = 64 * 1024;
const SYNC_BACK_BYTES: u64 = 64 * 1024;

/// The label of an OEM code page, or `None` for UTF-8 and unsupported pages.
pub fn oem_label(codepage: u32) -> Option<Label> {
    Some(match codepage {
        866 => "ibm866",
        874 => "windows-874",
        932 => "shift_jis",
        936 => "gbk",
        949 => "euc-kr",
        950 => "big5",
        1250 => "windows-1250",
        1251 => "windows-1251",
        1252 => "windows-1252",
        1253 => "windows-1253",
        1254 => "windows-1254",
        1255 => "windows-1255",
        1256 => "windows-1256",
        1257 => "windows-1257",
        1258 => "windows-1258",
        _ => return None,
    })
}

/// The system OEM code page, read once by the host at start.
#[cfg(windows)]
#[allow(unused_unsafe, reason = "windows-sys declares the call safe or unsafe by release")]
pub fn detect_oem_codepage() -> u32 {
    // SAFETY: a plain query with no arguments.
    unsafe { windows_sys::Win32::Globalization::GetOEMCP() }
}

fn is_dbcs_lead(label: &str, b: u8) -> Option<bool> {
    match label {
        "euc-kr" | "gbk" | "big5" => Some((0x81..=0xfe).contains(&b)),
        "shift_jis" => Some((0x81..=0x9f).contains(&b) || (0xe0..=0xfc).contains(&b)),
        _ => None,
    }
}

fn is_valid_utf8_stream(window: &[u8]) -> bool {
    match std::str::from_utf8(window) {
        Ok(_) => true,
        Err(error) => error.error_len().is_none(),
    }
}

/// `evaluateWindow`: `(label, firm)`; a non-firm label only comes from `final_`.
pub fn evaluate_window(buffer: &[u8], oem: Option<Label>, final_: bool) -> (Option<Label>, bool) {
    let (mut first, mut count, mut cut) = (None, 0usize, buffer.len());
    for (i, b) in buffer.iter().enumerate() {
        if *b < 0x80 {
            continue;
        }
        first.get_or_insert(i);
        count += 1;
        if count == NON_ASCII_DECISION_BYTES {
            cut = i + 1;
            break;
        }
    }
    let Some(first) = first else {
        return (final_.then_some("utf-8"), false);
    };
    let decisive = count >= NON_ASCII_DECISION_BYTES || buffer.len() - first >= WINDOW_CAP;
    let window = &buffer[first..cut.min(first + WINDOW_CAP)];
    if !is_valid_utf8_stream(window) {
        return (oem, true);
    }
    if decisive {
        return (Some("utf-8"), true);
    }
    // A valid prefix, possibly ending in an incomplete sequence, is never evidence of OEM.
    (final_.then_some("utf-8"), false)
}

/// `sniffShellEncoding`.
pub fn sniff_shell_encoding(buffer: &[u8], oem: Option<Label>, final_: bool) -> Option<Label> {
    if oem.is_none() {
        return Some("utf-8");
    }
    evaluate_window(buffer, oem, final_).0
}

fn encoding_of(label: Label) -> &'static Encoding {
    Encoding::for_label(label.as_bytes()).unwrap_or(encoding_rs::UTF_8)
}

fn run(decoder: &mut Decoder, bytes: &[u8], last: bool) -> String {
    let mut out = String::with_capacity(decoder.max_utf8_buffer_length(bytes.len()).unwrap_or(bytes.len() * 3 + 8));
    let _ = decoder.decode_to_string(bytes, &mut out, last);
    out
}

/// `decodeShellBytes`: a whole stream.
pub fn decode_shell_bytes(buffer: &[u8], oem: Option<Label>) -> String {
    let Some(oem) = oem else {
        return String::from_utf8_lossy(buffer).into_owned();
    };
    let label = sniff_shell_encoding(buffer, Some(oem), true).unwrap_or("utf-8");
    run(&mut encoding_of(label).new_decoder(), buffer, true)
}

/// Smallest character boundary `>= offset` in `bytes` (the stream's retained bytes starting at
/// absolute `base`); never an unverified offset.
pub fn aligned_offset(bytes: &[u8], base: u64, offset: u64, label: Label) -> u64 {
    if offset <= base {
        return offset.max(base).min(base + bytes.len() as u64).max(offset.min(base));
    }
    let at = |abs: u64| bytes.get((abs - base) as usize).copied();
    if label == "utf-8" {
        let mut i = 0;
        while i < 3 && at(offset + i).is_some_and(|b| (b & 0xc0) == 0x80) {
            i += 1;
        }
        return offset + i;
    }
    if is_dbcs_lead(label, 0).is_none() {
        return offset;
    }
    let low = offset.saturating_sub(SYNC_BACK_BYTES).max(base);
    let mut start = low;
    let mut j = offset;
    while j > low {
        j -= 1;
        if at(j).is_some_and(|b| b < 0x40) {
            start = j + 1;
            break;
        }
    }
    let mut pos = start;
    while pos < offset {
        let step = if at(pos).is_some_and(|b| is_dbcs_lead(label, b) == Some(true)) { 2 } else { 1 };
        pos += step;
    }
    pos
}

/// `FileEncodingSniffer` over a stream's bytes from an absolute offset (all memory holds of it, or
/// just the window from its first non-ASCII byte): one decision per stream, remembered only when
/// firm.
pub struct Sniffer {
    oem: Option<Label>,
    label: Option<Label>,
    scan_pos: u64,
    first: Option<u64>,
}

impl Sniffer {
    pub fn new(oem: Option<Label>) -> Self {
        Self { oem, label: oem.is_none().then_some("utf-8"), scan_pos: 0, first: None }
    }

    /// Offset up to which bytes are safe to decode while undecided.
    pub fn safe_end(&self, size: u64) -> u64 {
        if self.label.is_some() { size } else { self.first.unwrap_or(size) }
    }

    /// The label, or `None` while undecided. `bytes` holds the stream from absolute `base` on: all
    /// that memory holds, or the window from its first non-ASCII byte (`Stream::probe` in jobs.rs).
    pub fn probe(&mut self, bytes: &[u8], base: u64, final_: bool) -> Option<Label> {
        if self.label.is_some() {
            return self.label;
        }
        let size = base + bytes.len() as u64;
        self.scan_pos = self.scan_pos.max(base);
        if self.first.is_none() {
            while self.scan_pos < size {
                let from = (self.scan_pos - base) as usize;
                let chunk = &bytes[from..bytes.len().min(from + SCAN_CHUNK)];
                if let Some(i) = chunk.iter().position(|b| *b >= 0x80) {
                    self.first = Some(self.scan_pos + i as u64);
                    break;
                }
                self.scan_pos += chunk.len() as u64;
            }
        }
        let Some(first) = self.first else {
            return final_.then_some("utf-8");
        };
        let from = (first - base) as usize;
        let window = &bytes[from..bytes.len().min(from + WINDOW_CAP)];
        let (label, firm) = evaluate_window(window, self.oem, final_);
        if firm {
            self.label = label;
        }
        label
    }
}

fn finish(decoder: &mut Decoder) -> String {
    let text = run(decoder, &[], true);
    *decoder = decoder.encoding().new_decoder();
    text
}

enum State {
    /// No OEM page: a plain UTF-8 decoder (bytes of a cut character wait for the next write).
    Plain(Decoder),
    Undecided,
    Committed(Decoder),
}

/// A stateful per-stream decoder (`ShellStreamDecoder`) with `write`/`end`.
pub struct ShellStreamDecoder {
    oem: Option<Label>,
    state: State,
    held: Vec<u8>,
}

impl ShellStreamDecoder {
    /// `label` pre-commits the encoding.
    pub fn new(oem: Option<Label>, label: Option<Label>) -> Self {
        let state = match (oem, label) {
            (None, _) => State::Plain(encoding_rs::UTF_8.new_decoder_without_bom_handling()),
            (Some(_), Some(label)) => State::Committed(encoding_of(label).new_decoder()),
            (Some(_), None) => State::Undecided,
        };
        Self { oem, state, held: Vec::new() }
    }

    /// Commits `label` while still undecided with nothing held (ASCII only so far).
    pub fn force(&mut self, label: Label) {
        if matches!(self.state, State::Undecided) {
            self.state = State::Committed(encoding_of(label).new_decoder());
        }
    }

    fn commit(&mut self, label: Label) -> String {
        let mut decoder = encoding_of(label).new_decoder();
        let held = std::mem::take(&mut self.held);
        let text = run(&mut decoder, &held, false);
        self.state = State::Committed(decoder);
        text
    }

    pub fn write(&mut self, chunk: &[u8]) -> String {
        match &mut self.state {
            State::Plain(decoder) | State::Committed(decoder) => return run(decoder, chunk, false),
            State::Undecided => {}
        }
        let mut out = String::new();
        let mut rest = chunk;
        if self.held.is_empty() {
            let ascii = chunk.iter().take_while(|b| **b < 0x80).count();
            out.push_str(&String::from_utf8_lossy(&chunk[..ascii]));
            if ascii == chunk.len() {
                return out;
            }
            rest = &chunk[ascii..];
        }
        let take = rest.len().min(WINDOW_CAP - self.held.len());
        self.held.extend_from_slice(&rest[..take]);
        let Some(label) = evaluate_window(&self.held, self.oem, false).0 else {
            return out;
        };
        out.push_str(&self.commit(label));
        if take < rest.len() {
            if let State::Committed(decoder) = &mut self.state {
                out.push_str(&run(decoder, &rest[take..], false));
            }
        }
        out
    }

    /// Flushes what a cut character left. Like Node's `StringDecoder.end()`, the decoder stays
    /// usable for a later write (`encoding_rs` forbids reuse once finished, so it is replaced by
    /// a fresh one of the same encoding).
    pub fn end(&mut self) -> String {
        match &mut self.state {
            State::Plain(decoder) => {
                let text = run(decoder, &[], true);
                *decoder = encoding_rs::UTF_8.new_decoder_without_bom_handling();
                text
            }
            State::Committed(decoder) => finish(decoder),
            State::Undecided => {
                if self.held.is_empty() {
                    return String::new();
                }
                let label = evaluate_window(&self.held, self.oem, true).0.unwrap_or("utf-8");
                let mut text = self.commit(label);
                if let State::Committed(decoder) = &mut self.state {
                    text.push_str(&finish(decoder));
                }
                text
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// "한글 출력" in CP949 (EUC-KR).
    const KOREAN_CP949: [u8; 11] = [0xC7, 0xD1, 0xB1, 0xDB, 0x20, 0xC3, 0xE2, 0xB7, 0xC2, 0x0D, 0x0A];

    #[test]
    fn oem_pages_map_to_whatwg_labels() {
        assert_eq!(oem_label(949), Some("euc-kr"));
        assert_eq!(oem_label(932), Some("shift_jis"));
        assert_eq!(oem_label(1252), Some("windows-1252"));
        assert_eq!(oem_label(437), None);
        assert_eq!(oem_label(65001), None);
    }

    #[test]
    fn korean_oem_output_is_decoded_not_garbled() {
        let oem = Some("euc-kr");
        assert_eq!(decode_shell_bytes(&KOREAN_CP949, oem), "한글 출력\r\n");
        // Valid UTF-8 stays UTF-8 even when an OEM page is configured.
        assert_eq!(decode_shell_bytes("한글".as_bytes(), oem), "한글");
        // Without an OEM page the bytes are UTF-8.
        assert_eq!(decode_shell_bytes(b"abc", None), "abc");
    }

    #[test]
    fn a_stream_decoder_waits_for_a_decision_and_survives_split_characters() {
        let mut d = ShellStreamDecoder::new(Some("euc-kr"), None);
        assert_eq!(d.write(b"ok "), "ok ");
        // Half of a double-byte character: held, nothing yet decidable as OEM... it is invalid UTF-8.
        let first = d.write(&KOREAN_CP949[..1]);
        let rest = d.write(&KOREAN_CP949[1..]);
        let end = d.end();
        assert_eq!(format!("{first}{rest}{end}"), "한글 출력\r\n");

        let mut utf8 = ShellStreamDecoder::new(Some("euc-kr"), None);
        let bytes = "é".as_bytes();
        assert_eq!(utf8.write(&bytes[..1]), "");
        assert_eq!(format!("{}{}", utf8.write(&bytes[1..]), utf8.end()), "é");
    }

    #[test]
    fn the_window_rule_decides_per_stream() {
        assert_eq!(evaluate_window(b"plain", Some("euc-kr"), false), (None, false));
        assert_eq!(evaluate_window(b"plain", Some("euc-kr"), true), (Some("utf-8"), false));
        assert_eq!(evaluate_window(&KOREAN_CP949, Some("euc-kr"), false), (Some("euc-kr"), true));
        let many = "가".repeat(10);
        assert_eq!(evaluate_window(many.as_bytes(), Some("euc-kr"), false), (Some("utf-8"), true));
    }

    #[test]
    fn a_sniffer_finds_the_first_non_ascii_byte_and_remembers_a_firm_label() {
        let mut sniffer = Sniffer::new(Some("euc-kr"));
        assert_eq!(sniffer.probe(b"ascii only", 0, false), None);
        assert_eq!(sniffer.safe_end(10), 10);
        let mut bytes = b"ascii ".to_vec();
        bytes.extend_from_slice(&KOREAN_CP949);
        assert_eq!(sniffer.probe(&bytes, 0, false), Some("euc-kr"));
        assert_eq!(sniffer.probe(&bytes, 0, false), Some("euc-kr"));
    }

    #[test]
    fn alignment_never_splits_a_character() {
        // UTF-8: skip continuation bytes.
        let text = "a가나".as_bytes();
        assert_eq!(aligned_offset(text, 0, 2, "utf-8"), 4);
        // DBCS: walk from the previous single-byte character.
        let mut bytes = b"x".to_vec();
        bytes.extend_from_slice(&KOREAN_CP949[..8]);
        assert_eq!(aligned_offset(&bytes, 0, 2, "euc-kr"), 3);
        assert_eq!(aligned_offset(&bytes, 0, 3, "euc-kr"), 3);
    }
}
