//! Frame layout and the forward-scan classification (FORMAT.md §2–§3).
//!
//! ```text
//! <ordinal:16 hex> SP <len:8 hex> SP <crc:8 hex> SP <hcrc:8 hex> SP <payload: len bytes> LF
//! ```
//! Hex digits are lowercase. `crc` is CRC-32C of the payload; `hcrc` is CRC-32C of header
//! bytes `[0, HCRC_COVERED)` (ordinal, len, crc and their separators). The same frame is
//! used by session logs and the migration journal.

use serde::Deserialize;
use serde::Serialize;

use mixdog_protocol::INLINE_MAX;

/// Byte offsets inside a frame.
pub const ORDINAL_AT: usize = 0;
pub const ORDINAL_DIGITS: usize = 16;
pub const LEN_AT: usize = 17;
pub const LEN_DIGITS: usize = 8;
pub const CRC_AT: usize = 26;
pub const CRC_DIGITS: usize = 8;
pub const HCRC_AT: usize = 35;
pub const HCRC_DIGITS: usize = 8;
/// Positions of the four separating spaces.
pub const SEPARATORS: [usize; 4] = [16, 25, 34, 43];
/// `hcrc` covers `frame[0..HCRC_COVERED]`.
pub const HCRC_COVERED: usize = 35;
/// Header = ordinal, len, crc and hcrc fields with their separators; the payload starts here.
pub const HEADER_LEN: usize = 44;
/// Header plus the terminating LF: a frame is `FRAME_OVERHEAD + len` bytes.
pub const FRAME_OVERHEAD: usize = HEADER_LEN + 1;
pub const TERMINATOR: u8 = b'\n';
pub const SEPARATOR: u8 = b' ';

/// CRC-32C (Castagnoli), reflected polynomial, init and final XOR `0xFFFF_FFFF`.
pub const CRC32C_POLY_REFLECTED: u32 = 0x82F6_3B78;
/// CRC-32C of the ASCII bytes `123456789`.
pub const CRC32C_CHECK: u32 = 0xE306_9283;

/// Encoded bytes of every field of a record other than its one body slot's inline value,
/// at their type bounds (FORMAT.md §3.3; the largest kind, `item`, needs 34,324).
pub const NON_BODY_MAX: usize = 40 * 1024;
/// Largest payload a frame may declare. A larger `len` is corruption.
pub const MAX_FRAME_PAYLOAD: usize = INLINE_MAX + NON_BODY_MAX;
/// Largest whole frame.
pub const MAX_FRAME_LEN: usize = MAX_FRAME_PAYLOAD + FRAME_OVERHEAD;

/// Bytes of frames after which the writer starts the next batch with a `checkpoint`.
pub const CHECKPOINT_EVERY: u64 = 1024 * 1024;
/// Bytes of frames a session may have written but not yet acknowledged (RL §6.2 window);
/// the most one write batch holds.
pub const DURABILITY_WINDOW_BYTES: u64 = 4 * 1024 * 1024;
/// Reader bound (FORMAT.md §6.3): the bytes from the start of the newest committed
/// `checkpoint` (or `session`) frame of the newest log file to its end are fewer.
pub const REVERSE_SCAN_MAX: u64 = CHECKPOINT_EVERY + 2 * DURABILITY_WINDOW_BYTES;
/// A log file is not appended past this size; the next batch starts a new file.
pub const ROTATE_AT: u64 = 64 * 1024 * 1024;

/// Session log files are `log.<nnnnnn>`, six decimal digits from `000000`.
pub const LOG_FILE_PREFIX: &str = "log.";
pub const LOG_FILE_DIGITS: usize = 6;
pub const LOG_FILE_MAX_NO: u32 = 999_999;

/// Outcome of a forward scan that starts at a known frame start (FORMAT.md §3.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "end", rename_all = "snake_case", deny_unknown_fields)]
pub enum ScanEnd {
    /// Every byte up to end of file is committed frames.
    Clean,
    /// The bytes from `offset` to end of file are a torn tail: never acknowledged,
    /// dropped by the first open-for-append.
    Torn { offset: u64 },
    /// The bytes at `offset` are damaged; `ordinal` is the ordinal expected there.
    Corrupt {
        offset: u64,
        ordinal: u64,
        cause: CorruptCause,
    },
}

/// Why the bytes at a frame start are corruption (FORMAT.md §3.2). The header causes are
/// decided by one procedure over the present header bytes, complete or not (rule 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CorruptCause {
    /// The present `hcrc` bytes are not the start of the CRC-32C of header bytes
    /// `[0, HCRC_COVERED)` as hex followed by SP, or a separator is not SP.
    Header,
    /// The present ordinal bytes are not the start of the expected ordinal (gap, repeat,
    /// wrong log, garbage).
    Ordinal,
    /// A `len` byte is not lowercase hex, or no completion of the present digits is
    /// ≤ `MAX_FRAME_PAYLOAD`.
    Length,
    /// A `crc` byte is not lowercase hex, or a fully present payload's CRC differs.
    Crc,
    /// A CRC-valid payload followed by a written byte other than LF.
    Framing,
}
