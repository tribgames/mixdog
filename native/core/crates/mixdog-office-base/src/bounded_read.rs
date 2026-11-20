//! Bounded whole-file reads for snapshot, rollback, patch and rescue paths (`shared/bounded-file-read.mjs`).
//!
//! The size is decided from the OPENED handle and enforced again while reading: no more than `max_bytes + 1` bytes are
//! ever pulled into memory, so a file that grows after any earlier check is still caught. Binary-ness is decided from
//! the WHOLE bounded content with the patch-target codec rule ([`detect_text_codec`]), never from a prefix. Every
//! function takes the proof of the lane job it runs in.

use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use mixdog_fsio::{File, ReadProof};
use mixdog_js::number_to_string;

const MIB: u64 = 1024 * 1024;

/// Per-file limit for content the patch/rescue paths may hold in memory.
pub const PATCH_SNAPSHOT_MAX_BYTES: u64 = 8 * MIB;
/// Byte budget one transaction's snapshots may hold together.
pub const PATCH_SNAPSHOT_BUDGET_BYTES: u64 = 64 * MIB;
/// Per-file limit for a text file `apply_patch` may edit, rename and snapshot for rollback and turn undo.
pub const PATCH_EDIT_MAX_BYTES: u64 = 64 * MIB;
/// Byte budget one patch transaction's rollback snapshots may hold together.
pub const PATCH_EDIT_BUDGET_BYTES: u64 = 2 * PATCH_EDIT_MAX_BYTES;

/// A BOM-less UTF-16 verdict needs 16 code units of evidence: below that a NUL is as likely to be a stray byte inside
/// UTF-8 text.
const UTF16_MIN_EVIDENCE_BYTES: usize = 32;
const UTF16_MIN_NUL_RATIO: f64 = 0.5;

/// `createSnapshotBudget`: the bytes one set of snapshots may hold together.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotBudget {
    pub total: u64,
    pub remaining: u64,
}

impl SnapshotBudget {
    pub fn new(total: u64) -> Self {
        Self { total, remaining: total }
    }
}

impl Default for SnapshotBudget {
    fn default() -> Self {
        Self::new(PATCH_SNAPSHOT_BUDGET_BYTES)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding {
    Utf8,
    Utf16Le,
    Utf16Be,
}

/// The codec of a text file. `certain: false` means the bytes cannot be attributed to one codec (`encoding` is
/// `None`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextCodec {
    pub encoding: Option<Encoding>,
    pub bom_len: usize,
    pub certain: bool,
}

/// `detectTextCodec`: a BOM is authoritative; a BOM-less file is classified by NUL-byte parity, which is what
/// separates UTF-16 text from UTF-8 text. `bytes` must be the WHOLE file: a prefix cannot rule out a parity flip further
/// in, so a prefix-only caller passes `partial` and gets "undecidable" instead of a guess.
pub fn detect_text_codec(bytes: &[u8], partial: bool) -> TextCodec {
    let undecidable = TextCodec { encoding: None, bom_len: 0, certain: false };
    let certain = |encoding, bom_len| TextCodec { encoding: Some(encoding), bom_len, certain: true };
    match bytes {
        [0xff, 0xfe, ..] => return certain(Encoding::Utf16Le, 2),
        [0xfe, 0xff, ..] => return certain(Encoding::Utf16Be, 2),
        [0xef, 0xbb, 0xbf, ..] => return certain(Encoding::Utf8, 3),
        _ => {}
    }
    let mut nul_even = 0usize;
    let mut nul_odd = 0usize;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != 0 {
            continue;
        }
        if index % 2 == 0 {
            nul_even += 1;
        } else {
            nul_odd += 1;
        }
    }
    if partial {
        return undecidable;
    }
    if nul_even == 0 && nul_odd == 0 {
        return certain(Encoding::Utf8, 0);
    }
    if bytes.len() < UTF16_MIN_EVIDENCE_BYTES || bytes.len() % 2 != 0 {
        return undecidable;
    }
    let even_slots = bytes.len().div_ceil(2) as f64;
    let odd_slots = (bytes.len() / 2) as f64;
    if nul_even == 0 && nul_odd as f64 / odd_slots >= UTF16_MIN_NUL_RATIO {
        return certain(Encoding::Utf16Le, 0);
    }
    if nul_odd == 0 && nul_even as f64 / even_slots >= UTF16_MIN_NUL_RATIO {
        return certain(Encoding::Utf16Be, 0);
    }
    undecidable
}

/// `looksBinary`: NUL bytes the text codec cannot attribute. `content` must be the whole file.
pub fn looks_binary(content: &[u8]) -> bool {
    content.contains(&0) && !detect_text_codec(content, false).certain
}

/// Why a read returned no content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OmitReason {
    Oversized,
    Binary,
    Budget,
}

impl OmitReason {
    /// The word Node records (`'oversized'`, `'binary'`, `'budget'`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Oversized => "oversized",
            Self::Binary => "binary",
            Self::Budget => "budget",
        }
    }
}

/// What the handle said about the file.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FileMeta {
    pub stat_size: u64,
    pub mtime_ms: f64,
}

/// The answer of one bounded read.
#[derive(Debug, Clone, PartialEq)]
pub enum BoundedRead {
    Absent,
    Present {
        content: Vec<u8>,
        meta: FileMeta,
    },
    /// No content: `size` is what was seen, `limit` the per-file limit (the budget's total for `Budget`).
    Omitted {
        reason: OmitReason,
        meta: FileMeta,
        size: u64,
        limit: u64,
    },
    /// `classify_only`: size and binary-ness were checked from a bounded read, content not returned or charged.
    Classified {
        meta: FileMeta,
        size: u64,
    },
}

#[derive(Debug, Clone, Copy)]
pub struct BoundedReadOptions {
    pub max_bytes: u64,
    pub classify_only: bool,
    /// `false` returns NUL-bearing content as present, for callers that run the codec decision themselves.
    pub detect_binary: bool,
}

impl Default for BoundedReadOptions {
    fn default() -> Self {
        Self { max_bytes: PATCH_SNAPSHOT_MAX_BYTES, classify_only: false, detect_binary: true }
    }
}

/// Why a bounded read failed: anything but a regular file (`ENOTREGULAR`; symlinks are followed, like `statSync`), or
/// any other open/read error unchanged.
#[derive(Debug)]
pub enum BoundedReadError {
    NotRegular(PathBuf),
    Io(io::Error),
}

impl std::fmt::Display for BoundedReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotRegular(path) => write!(f, "not a regular file: {}", path.display()),
            Self::Io(error) => error.fmt(f),
        }
    }
}

impl From<io::Error> for BoundedReadError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

/// `ENOENT` and `ENOTDIR`.
fn is_absent(error: &io::Error) -> bool {
    matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory)
}

fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    meta.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map_or(0.0, |since| since.as_secs_f64() * 1000.0)
}

/// `readBoundedFile`: one bounded read of a whole file.
pub fn read_bounded_file<P: ReadProof>(
    proof: &P,
    path: &Path,
    opts: &BoundedReadOptions,
    mut budget: Option<&mut SnapshotBudget>,
) -> Result<BoundedRead, BoundedReadError> {
    let stat = match mixdog_fsio::metadata(proof, path) {
        Ok(stat) => stat,
        Err(error) if is_absent(&error) => return Ok(BoundedRead::Absent),
        Err(error) => return Err(error.into()),
    };
    // Checked before open: opening a FIFO would block.
    if !stat.is_file() {
        return Err(BoundedReadError::NotRegular(path.to_owned()));
    }
    let mut file = match File::open(proof, path) {
        Ok(file) => file,
        Err(error) if is_absent(&error) => return Ok(BoundedRead::Absent),
        Err(error) => return Err(error.into()),
    };
    let opened = file.metadata(proof)?;
    if !opened.is_file() {
        return Err(BoundedReadError::NotRegular(path.to_owned()));
    }
    let meta = FileMeta { stat_size: opened.len(), mtime_ms: mtime_ms(&opened) };
    let budget_total = budget.as_deref().map(|budget| budget.total);
    let omitted = |reason: OmitReason, size: u64| BoundedRead::Omitted {
        reason,
        meta,
        size,
        limit: if reason == OmitReason::Budget { budget_total.unwrap_or(opts.max_bytes) } else { opts.max_bytes },
    };
    if opened.len() > opts.max_bytes {
        return Ok(omitted(OmitReason::Oversized, opened.len()));
    }
    if !opts.classify_only && budget.as_deref().is_some_and(|budget| opened.len() > budget.remaining) {
        return Ok(omitted(OmitReason::Budget, opened.len()));
    }
    let mut content = Vec::new();
    (&mut file).take(opts.max_bytes + 1).read_to_end(&mut content)?;
    let total = content.len() as u64;
    if total > opts.max_bytes {
        return Ok(omitted(OmitReason::Oversized, total));
    }
    if opts.detect_binary && looks_binary(&content) {
        return Ok(omitted(OmitReason::Binary, total));
    }
    if opts.classify_only {
        return Ok(BoundedRead::Classified { meta, size: total });
    }
    if let Some(budget) = budget.as_deref_mut() {
        if total > budget.remaining {
            return Ok(omitted(OmitReason::Budget, total));
        }
        budget.remaining -= total;
    }
    Ok(BoundedRead::Present { content, meta })
}

/// A file's state for the turn review of a tool write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReviewContent {
    Absent,
    /// Its bytes, binary included, up to [`PATCH_EDIT_MAX_BYTES`] and within the budget.
    Bytes(Vec<u8>),
    /// Counted as changed, never diffed or restored.
    Omitted {
        size: u64,
        reason: OmitReason,
    },
}

/// `reviewFileContent`: the state of a file for the turn review of a tool write.
pub fn review_file_content<P: ReadProof>(proof: &P, path: &Path, budget: Option<&mut SnapshotBudget>) -> Result<ReviewContent, BoundedReadError> {
    let opts = BoundedReadOptions { max_bytes: PATCH_EDIT_MAX_BYTES, classify_only: false, detect_binary: false };
    Ok(match read_bounded_file(proof, path, &opts, budget)? {
        BoundedRead::Absent => ReviewContent::Absent,
        BoundedRead::Omitted { reason, size, .. } => ReviewContent::Omitted { size, reason },
        BoundedRead::Present { content, .. } => ReviewContent::Bytes(content),
        // `classify_only` is never set here.
        BoundedRead::Classified { .. } => ReviewContent::Absent,
    })
}

/// `describeOmittedFile`: "binary (N bytes)", "larger than 8 MiB (N bytes)". A `limit` of 0 is the default limit.
pub fn describe_omitted_file(reason: OmitReason, size: u64, limit: u64) -> String {
    let bytes = format!("{size} bytes");
    let mib = |limit: u64, default: u64| {
        let bytes = if limit == 0 { default } else { limit };
        number_to_string(bytes as f64 / MIB as f64)
    };
    match reason {
        OmitReason::Binary => format!("binary (NUL bytes without a decidable text encoding, {bytes})"),
        OmitReason::Budget => {
            format!("over the {} MiB per-patch snapshot budget ({bytes})", mib(limit, PATCH_SNAPSHOT_BUDGET_BYTES))
        }
        OmitReason::Oversized => format!("larger than {} MiB ({bytes})", mib(limit, PATCH_SNAPSHOT_MAX_BYTES)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_fsio::Unlaned;

    fn file(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        mixdog_fsio::write(&Unlaned, &path, bytes).expect("write");
        path
    }

    fn read(path: &Path, opts: BoundedReadOptions, budget: Option<&mut SnapshotBudget>) -> BoundedRead {
        read_bounded_file(&Unlaned, path, &opts, budget).expect("read")
    }

    #[test]
    fn a_bom_decides_the_codec_and_nul_parity_the_rest() {
        assert_eq!(detect_text_codec(&[0xff, 0xfe, b'a', 0], false).encoding, Some(Encoding::Utf16Le));
        assert_eq!(detect_text_codec(&[0xfe, 0xff, 0, b'a'], false).encoding, Some(Encoding::Utf16Be));
        assert_eq!(detect_text_codec(&[0xef, 0xbb, 0xbf, b'a'], false), TextCodec { encoding: Some(Encoding::Utf8), bom_len: 3, certain: true });
        assert!(detect_text_codec(b"plain text", false).certain);
        assert!(!detect_text_codec(b"plain text", true).certain);
        // Short NUL-bearing input is undecidable; sixteen UTF-16LE units are decided.
        assert!(!detect_text_codec(&[b'a', 0, b'b', 0], false).certain);
        let wide: Vec<u8> = "abcdefghijklmnop".encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(detect_text_codec(&wide, false).encoding, Some(Encoding::Utf16Le));
        assert!(looks_binary(&[0, 1, 2]));
        assert!(!looks_binary(&wide));
    }

    #[test]
    fn a_read_answers_absent_present_oversized_binary_and_budget() {
        let dir = tempfile::tempdir().expect("dir");
        assert_eq!(read(&dir.path().join("none"), BoundedReadOptions::default(), None), BoundedRead::Absent);
        let text = file(dir.path(), "t.txt", b"hello");
        let BoundedRead::Present { content, meta } = read(&text, BoundedReadOptions::default(), None) else { panic!("present") };
        assert_eq!((content.as_slice(), meta.stat_size), (&b"hello"[..], 5));
        let small = BoundedReadOptions { max_bytes: 4, ..BoundedReadOptions::default() };
        assert!(matches!(read(&text, small, None), BoundedRead::Omitted { reason: OmitReason::Oversized, size: 5, limit: 4, .. }));
        let nul = file(dir.path(), "b.bin", &[1, 0, 2]);
        assert!(matches!(read(&nul, BoundedReadOptions::default(), None), BoundedRead::Omitted { reason: OmitReason::Binary, size: 3, .. }));
        let raw = BoundedReadOptions { detect_binary: false, ..BoundedReadOptions::default() };
        assert!(matches!(read(&nul, raw, None), BoundedRead::Present { .. }));
        let mut budget = SnapshotBudget::new(8);
        assert!(matches!(read(&text, BoundedReadOptions::default(), Some(&mut budget)), BoundedRead::Present { .. }));
        assert_eq!(budget.remaining, 3);
        assert!(matches!(
            read(&text, BoundedReadOptions::default(), Some(&mut budget)),
            BoundedRead::Omitted { reason: OmitReason::Budget, size: 5, limit: 8, .. }
        ));
        let classify = BoundedReadOptions { classify_only: true, ..BoundedReadOptions::default() };
        assert!(matches!(read(&text, classify, Some(&mut budget)), BoundedRead::Classified { size: 5, .. }));
        assert_eq!(budget.remaining, 3);
    }

    #[test]
    fn a_directory_is_not_a_regular_file() {
        let dir = tempfile::tempdir().expect("dir");
        let error = read_bounded_file(&Unlaned, dir.path(), &BoundedReadOptions::default(), None).expect_err("directory");
        assert!(matches!(error, BoundedReadError::NotRegular(_)));
    }

    #[test]
    fn a_review_read_keeps_binary_bytes_and_marks_what_it_cannot_hold() {
        let dir = tempfile::tempdir().expect("dir");
        let nul = file(dir.path(), "b.bin", &[1, 0, 2]);
        assert_eq!(review_file_content(&Unlaned, &nul, None).expect("review"), ReviewContent::Bytes(vec![1, 0, 2]));
        assert_eq!(review_file_content(&Unlaned, &dir.path().join("none"), None).expect("review"), ReviewContent::Absent);
        let mut budget = SnapshotBudget::new(2);
        assert_eq!(review_file_content(&Unlaned, &nul, Some(&mut budget)).expect("review"), ReviewContent::Omitted { size: 3, reason: OmitReason::Budget });
    }

    #[test]
    fn omitted_files_are_described_in_words() {
        assert_eq!(describe_omitted_file(OmitReason::Binary, 12, 0), "binary (NUL bytes without a decidable text encoding, 12 bytes)");
        assert_eq!(describe_omitted_file(OmitReason::Oversized, 9_000_000, 0), "larger than 8 MiB (9000000 bytes)");
        assert_eq!(describe_omitted_file(OmitReason::Budget, 70_000_000, 0), "over the 64 MiB per-patch snapshot budget (70000000 bytes)");
        assert_eq!(describe_omitted_file(OmitReason::Budget, 5, 3 * MIB / 2), "over the 1.5 MiB per-patch snapshot budget (5 bytes)");
    }
}

impl std::error::Error for BoundedReadError {}
